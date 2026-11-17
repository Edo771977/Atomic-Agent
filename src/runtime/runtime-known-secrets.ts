import type { AtomicAgentConfig } from "../config/index.js";
import { knownSecretsFromEnv, type KnownSecret } from "../error-reporting/secret-detector.js";
import { isSecretEnvName } from "../sandbox/command-env.js";
import { commandIssuedSecrets } from "../llm/provider/openai/api-key-command.js";
import { resolveExtraApiKeys } from "../config/resolve-llm-api-key.js";

/** Header names whose value is a credential (`Authorization`, `X-Api-Key`, `Cookie`, ...). */
const SECRET_HEADER = /authorization|api[-_]?key|token|secret|password|cookie|auth/i;

/**
 * The exact secrets masked in tool output (ATO-1077): the agent's `.env`
 * (loaded into `process.env`) and the credentials stored in the config
 * file: provider keys and secret headers, explicitly configured key-env
 * references (including ordinary names), the local server's key,
 * webhook secrets, MCP servers' secret env values and headers, extra
 * provider keys (ATO-471) and the tokens provider key commands printed
 * this process (Vertex AI). Read
 * per call, so a key added mid-session (TUI: Esc → Manage › LLM › Cloud) is covered.
 */
export function runtimeKnownSecrets(
  config: Partial<Pick<AtomicAgentConfig, "llm" | "localModels" | "webhooks" | "mcp" | "web" | "composio">>,
  env: NodeJS.ProcessEnv = process.env,
): KnownSecret[] {
  const out = knownSecretsFromEnv(env);
  const add = (label: string, value: unknown): void => {
    if (typeof value === "string" && value.length > 0) out.push({ label, value });
  };
  const addEnv = (label: string, name: string | undefined): void => {
    if (name !== undefined) add(label, env[name]);
  };
  const addHeaders = (label: string, headers: Readonly<Record<string, string>> | undefined): void => {
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (!SECRET_HEADER.test(name)) continue;
      add(label, value);
      // `Bearer <token>` also appears without its scheme.
      const token = /^\S+\s+(\S{8,})$/.exec(value)?.[1];
      if (token !== undefined) add(label, token);
    }
  };
  for (const entry of config.llm?.providers ?? []) {
    add(`${entry.id}-key`, entry.apiKey);
    // Explicit credential references are secrets whatever their variable name.
    // Do not sweep unrelated environment values into the masking set.
    addEnv(`${entry.id}-key`, entry.apiKeyEnvVar);
    for (const extra of resolveExtraApiKeys(entry, env)) add(`${entry.id}-key`, extra);
    addHeaders(`${entry.id}-header`, entry.headers);
  }
  // Tokens printed by provider key commands (Vertex AI) live only in memory.
  for (const secret of commandIssuedSecrets()) add(secret.label, secret.value);
  addEnv("exa-key", config.web?.search.exa.apiKeyEnv);
  addEnv("brave-key", config.web?.search.brave.apiKeyEnv);
  addEnv("composio-key", config.composio?.apiKeyEnv);
  add("local-models-key", config.localModels?.apiKey);
  for (const [name, hook] of Object.entries(config.webhooks ?? {})) {
    add(`webhook-${name}-secret`, hook.secret);
  }
  for (const server of config.mcp?.servers ?? []) {
    for (const [name, value] of Object.entries(server.env ?? {})) {
      if (isSecretEnvName(name)) add(`mcp-${server.name}-${name}`, value);
    }
    if (server.transport.kind !== "stdio") addHeaders(`mcp-${server.name}-header`, server.transport.headers);
  }
  return out;
}
