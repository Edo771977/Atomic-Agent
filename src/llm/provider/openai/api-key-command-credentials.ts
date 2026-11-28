import type { AtomicAgentConfig } from "../../../config/index.js";
import { isSecretEnvName } from "../../../sandbox/command-env.js";

export interface KeyCommandCredentials {
  names?: readonly string[];
  values?: readonly string[];
}

/** Explicit credential references remain sensitive even under ordinary names. */
export function apiKeyCommandCredentials(
  config: Partial<Pick<AtomicAgentConfig, "llm" | "localModels" | "webhooks" | "mcp" | "web" | "composio">>,
): KeyCommandCredentials {
  const names: string[] = [];
  const values: string[] = [];
  const add = (value: string | null | undefined) => { if (value) values.push(value); };
  const name = (value: string | null | undefined) => { if (value) names.push(value); };
  const headers = (entries: Readonly<Record<string, string>> | undefined, keyHeader?: string) => {
    for (const [key, value] of Object.entries(entries ?? {})) {
      if (key.toLowerCase() !== keyHeader?.toLowerCase() &&
          !/authorization|api[-_]?key|token|secret|password|cookie|auth/i.test(key)) continue;
      add(value);
      add(/^\S+\s+(\S+)$/.exec(value)?.[1]);
    }
  };
  for (const entry of config.llm?.providers ?? []) {
    name(entry.apiKeyEnvVar);
    for (const extra of entry.extraApiKeyEnvVars ?? []) name(extra);
    add(entry.apiKey);
    headers(entry.headers, entry.apiKeyHeader);
  }
  name(config.web?.search.exa.apiKeyEnv);
  name(config.web?.search.brave.apiKeyEnv);
  name(config.composio?.apiKeyEnv);
  add(config.localModels?.apiKey);
  for (const hook of Object.values(config.webhooks ?? {})) add(hook.secret);
  for (const server of config.mcp?.servers ?? []) {
    for (const [key, value] of Object.entries(server.env ?? {})) if (isSecretEnvName(key)) add(value);
    if (server.transport.kind !== "stdio") headers(server.transport.headers);
  }
  return { names, values };
}
