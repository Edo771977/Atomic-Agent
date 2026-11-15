import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { totalmem } from "node:os";
import { join } from "node:path";

import type { AtomicAgentConfig } from "../config/index.js";
import { STRICT_CLOUD_KEY_VARS, MIN_CLOUD_KEY_LENGTH } from "../config/api-key-shape.js";
import { resolveStateDir } from "../config/load-config.js";
import { decodeDotenvBytes, dotenvTextValue } from "../config/load-dotenv.js";
import {
  resolveLlmProviderApiKey,
  resolveLlmProviderApiKeyWithSource,
  type LlmApiKeySource,
} from "../config/resolve-llm-api-key.js";
import type { UserLlmProviderEntry } from "../config/llm-config.js";
import { DEFAULT_AIMLAPI_BASE } from "../llm/provider/aimlapi/aimlapi-provider.js";
import { DEFAULT_ANTHROPIC_BASE } from "../llm/provider/anthropic/anthropic-route.js";
import { DEFAULT_GEMINI_BASE, GEMINI_API_PATH_PREFIX } from "../llm/provider/gemini/gemini-provider.js";
import { normalizeOpenAiBaseUrl } from "../llm/provider/openai/normalize-openai-base-url.js";
import { openAiChatPathPrefix } from "../llm/provider/openai/openai-chat-path.js";
import {
  DEFAULT_OPENROUTER_BASE,
  OPENROUTER_APP_CATEGORIES,
  OPENROUTER_APP_REFERER,
  OPENROUTER_APP_TITLE,
} from "../llm/provider/openrouter/openrouter-provider.js";
import {
  pickProbeModels,
  verifyProviderKey,
  type ProviderVerifyKind,
  type ProviderVerifyResult,
  type ProviderVerifyTarget,
} from "../llm/provider/verify/index.js";
import {
  getDaemonStatus,
  getLocalModelDef,
  isBackendDownloaded,
  isKnownLocalModelId,
  isModelDownloaded,
  type DaemonStatus,
} from "../local-llm/index.js";
import type { DoctorFinding } from "./doctor-checks.js";

/**
 * ATO-577, second step: the local engine and the cloud key, read from the
 * loaded config. These only run once config.json is valid (doctor-checks'
 * `config` check is ok). None of them offers a fix: each says the one
 * command that repairs it. The key check sends one real completion of one
 * token (verifyProviderKey), the only answer that proves a key works.
 */
export interface EngineProbes {
  daemonStatus: (dataDir: string, port: number) => Promise<DaemonStatus>;
  backendInstalled: (dataDir: string, engine: AtomicAgentConfig["localModels"]["managed"]["engine"]) => boolean;
  modelDownloaded: (dataDir: string, modelId: string) => boolean | null;
  minRamGb: (modelId: string) => number | null;
  totalRamGb: () => number;
  portFree: (port: number) => Promise<boolean>;
  reachable: (url: string) => Promise<boolean>;
  verifyKey: (target: ProviderVerifyTarget) => Promise<ProviderVerifyResult>;
  /** `<stateDir>/.env` and its text (`null` when absent or unreadable), to name a key's source. */
  readDotenv: () => { path: string; text: string | null };
}

export const REAL_ENGINE_PROBES: EngineProbes = {
  daemonStatus: (dir, port) => getDaemonStatus(dir, port),
  backendInstalled: (dir, engine) => isBackendDownloaded(dir, engine),
  modelDownloaded: (dir, id) => (isKnownLocalModelId(id) ? isModelDownloaded(dir, getLocalModelDef(id)) : null),
  minRamGb: (id) => (isKnownLocalModelId(id) ? getLocalModelDef(id).minRamGb : null),
  totalRamGb: () => totalmem() / 1024 ** 3,
  portFree: (port) =>
    new Promise((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    }),
  reachable: async (url) => {
    try {
      await fetch(url, { signal: AbortSignal.timeout(3_000) });
      return true;
    } catch {
      return false;
    }
  },
  verifyKey: (target) => verifyProviderKey(target),
  readDotenv: () => {
    const path = join(resolveStateDir(), ".env");
    try {
      return { path, text: decodeDotenvBytes(readFileSync(path)) };
    } catch {
      return { path, text: null };
    }
  },
};

function activeProvider(cfg: AtomicAgentConfig): UserLlmProviderEntry | null {
  const llm = cfg.llm;
  if (!llm) return null;
  return (llm.providers.find((p) => p.id === llm.activeTextProvider) as UserLlmProviderEntry | undefined) ?? null;
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** What to send the key check for a saved provider, or null when there is no key or nothing to ask. */
export function verifyTargetForEntry(entry: UserLlmProviderEntry): ProviderVerifyTarget | null {
  const apiKey = resolveLlmProviderApiKey(entry)?.trim();
  if (!apiKey) return null;
  let kind: ProviderVerifyKind;
  let baseUrl: string;
  let apiPathPrefix: string;
  let attribution: Record<string, string> | undefined;
  if (entry.kind === "openrouter") {
    [kind, baseUrl, apiPathPrefix] = ["openrouter", DEFAULT_OPENROUTER_BASE, "/v1"];
    attribution = { "HTTP-Referer": OPENROUTER_APP_REFERER, "X-Title": OPENROUTER_APP_TITLE, "X-OpenRouter-Categories": OPENROUTER_APP_CATEGORIES };
  }
  else if (entry.kind === "aimlapi") [kind, baseUrl, apiPathPrefix] = ["aimlapi", DEFAULT_AIMLAPI_BASE, "/v1"];
  else if (entry.kind === "gemini") [kind, baseUrl, apiPathPrefix] = ["gemini", DEFAULT_GEMINI_BASE, GEMINI_API_PATH_PREFIX];
  else if (entry.kind === "anthropic") {
    // The native Messages API: `GET /v1/models` with `x-api-key` proves the key.
    const anthropicBase = entry.baseUrl ?? DEFAULT_ANTHROPIC_BASE;
    if (isLoopback(anthropicBase)) return null;
    return {
      label: entry.id,
      baseUrl: anthropicBase,
      apiPathPrefix: "/v1",
      apiKey,
      probeModels: [],
      wire: "anthropic-messages",
      ...(entry.headers ? { extraHeaders: { ...entry.headers } } : {}),
    };
  }
  else if (entry.kind === "openai-compatible" && entry.baseUrl) {
    baseUrl = normalizeOpenAiBaseUrl(entry.baseUrl);
    [kind, apiPathPrefix] = ["openai-compatible", openAiChatPathPrefix(baseUrl)];
  } else return null;
  if (isLoopback(baseUrl)) return null;
  return {
    label: entry.id,
    baseUrl,
    apiPathPrefix,
    apiKey,
    probeModels: pickProbeModels({ kind, selectedModelId: entry.defaultChatModel ?? entry.model ?? null }),
    ...(entry.headers || attribution ? { extraHeaders: { ...attribution, ...entry.headers } } : {}),
  };
}

async function checkLocalEngine(cfg: AtomicAgentConfig, probes: EngineProbes): Promise<DoctorFinding[]> {
  const lm = cfg.localModels;
  if (lm.mode === "external") {
    const ok = await probes.reachable(`${lm.url.replace(/\/+$/, "")}/health`);
    return [{ check: "engine", status: ok ? "ok" : "fail", message: ok ? `your model server at ${lm.url} answers` : `nothing answers at ${lm.url}; start your model server or change localModels.url` }];
  }
  const out: DoctorFinding[] = [];
  const dir = cfg.paths.localModelsDataDir;
  const installed = probes.backendInstalled(dir, lm.managed.engine);
  out.push(installed
    ? { check: "engine", status: "ok", message: "the local engine is installed" }
    : { check: "engine", status: "fail", message: "the local engine is not installed; run `atag models update`" });
  const id = lm.managed.modelId;
  if (!id) {
    out.push({ check: "model", status: "warn", message: "no local model chosen; `atag models list`, then `atag models use <id>`" });
  } else {
    const have = probes.modelDownloaded(dir, id);
    if (have === false) out.push({ check: "model", status: "fail", message: `${id} is not downloaded; run \`atag models pull ${id}\`` });
    else if (have === null) out.push({ check: "model", status: "warn", message: `${id} is your own model; doctor cannot tell whether its file is on disk (\`atag models status\`)` });
    else out.push({ check: "model", status: "ok", message: `${id} is on disk` });
    const need = probes.minRamGb(id);
    const total = probes.totalRamGb();
    if (need !== null && total < need) {
      out.push({ check: "memory", status: "warn", message: `${id} needs about ${need} GB of memory, this computer has ${total.toFixed(0)} GB; pick a smaller model` });
    } else if (need !== null) {
      out.push({ check: "memory", status: "ok", message: `${total.toFixed(0)} GB of memory, ${id} needs about ${need} GB` });
    }
  }
  const st = await probes.daemonStatus(dir, lm.managed.port);
  if (st.authMismatch) {
    out.push({ check: "server", status: "fail", message: `a model server on port ${st.port} rejects this agent's key; run \`atag models stop\`, then \`atag models start\`` });
  } else if (st.running) {
    out.push({ check: "server", status: "ok", message: `model server ${st.healthy ? "running" : st.loading ? "loading" : "started, not answering yet"} on port ${st.port}` });
  } else if (!(await probes.portFree(lm.managed.port))) {
    out.push({ check: "server", status: "fail", message: `port ${lm.managed.port} is taken by another program, so the model server cannot start; close it or change localModels.managed.port` });
  } else {
    out.push({ check: "server", status: "ok", message: `model server stopped; port ${lm.managed.port} is free and it starts with the agent` });
  }
  return out;
}

/**
 * Where the key came from, in words, plus a warning when this shell's
 * value for the variable differs from `<stateDir>/.env`'s (the shell
 * wins, so a stale or placeholder value there hides the saved key).
 * Only names and lengths: never a value or a prefix of one.
 */
function describeKeySource(
  source: LlmApiKeySource,
  length: number,
  value: string | null,
  dotenv: { path: string; text: string | null },
): { where: string; warning: DoctorFinding | null } {
  if (source.kind === "config") return { where: `apiKey in config.json (${length} characters)`, warning: null };
  const fileValue = dotenv.text === null ? undefined : dotenvTextValue(dotenv.text, source.name);
  if (fileValue !== undefined && fileValue.length > 0 && value !== null && fileValue === value) {
    return { where: `${source.name} from ${dotenv.path} (${length} characters)`, warning: null };
  }
  const where = `${source.name} from this shell's environment (${length} characters)`;
  if (fileValue === undefined || fileValue.length === 0) return { where, warning: null };
  return {
    where,
    warning: {
      check: "key-source",
      status: "warn",
      message:
        `${source.name} is set in this shell and overrides the one in ${dotenv.path}; they differ ` +
        `(shell: ${length} characters, .env: ${fileValue.trim().length}). ` +
        `Close this window or clear it (PowerShell: Remove-Item Env:${source.name}; sh: unset ${source.name}) to use the saved key`,
    },
  };
}

async function checkCloudKey(entry: UserLlmProviderEntry, probes: EngineProbes): Promise<DoctorFinding[]> {
  const target = verifyTargetForEntry(entry);
  const testable = ["openrouter", "aimlapi", "gemini", "anthropic"].includes(entry.kind) || (entry.kind === "openai-compatible" && !!entry.baseUrl && !isLoopback(entry.baseUrl));
  if (!target && !testable) return [{ check: "key", status: "ok", message: `${entry.id} (${entry.kind}): doctor does not test this kind of provider` }];
  const resolution = resolveLlmProviderApiKeyWithSource(entry);
  const dotenv = probes.readDotenv();
  if (!target) {
    const ignored = resolution.ignored;
    if (ignored) {
      const where = ignored.source.kind === "config" ? "apiKey in config.json" : `${ignored.source.name} in this shell's environment`;
      return [{
        check: "key",
        status: "warn",
        message: `${entry.id}: no usable API key; ${where} ${ignored.reason} (${ignored.length} characters), so it was not sent. Put the real key in ${dotenv.path} and clear the shell variable`,
      }];
    }
    return [{ check: "key", status: "warn", message: `${entry.id}: no API key found in config.json, ${dotenv.path} or the environment` }];
  }
  const key = resolution.key;
  const source = key
    ? describeKeySource(key.source, key.value.trim().length, key.source.kind === "env" ? (process.env[key.source.name] ?? null) : null, dotenv)
    : null;
  const from = source ? ` (the key: ${source.where})` : "";
  const extra = source?.warning ? [source.warning] : [];
  const short =
    key && key.source.kind === "env" && STRICT_CLOUD_KEY_VARS.has(key.source.name) && key.value.trim().length < MIN_CLOUD_KEY_LENGTH
      ? `; ${key.source.name} is shorter than a real key`
      : "";
  const r = await probes.verifyKey(target);
  const who = `${entry.id}`;
  switch (r.status) {
    case "ok": return [{ check: "key", status: "ok", message: `${who} accepted the key${r.probedModel ? ` (tested with ${r.probedModel})` : ""}${from}` }, ...extra];
    case "rate_limited": return [{ check: "key", status: "ok", message: `${who} is rate-limiting the key right now; the key itself works${from}` }, ...extra];
    case "invalid_key": return [{ check: "key", status: "fail", message: `${who} rejected the key${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ""}${from}${short}; paste a new one in the provider settings` }, ...extra];
    case "no_balance": return [{ check: "key", status: "fail", message: `${who} accepted the key but the account has no balance; top it up${from}` }, ...extra];
    default: return [{ check: "key", status: "warn", message: `${who}: the key could not be tested (${r.status}${r.detail ? `: ${r.detail}` : ""})${from}` }, ...extra];
  }
}

export async function runEngineChecks(cfg: AtomicAgentConfig, probes: EngineProbes = REAL_ENGINE_PROBES): Promise<DoctorFinding[]> {
  const active = activeProvider(cfg);
  // No registry, or the local entry: the chat runs on the local engine.
  if (!active || active.kind === "llama-server") return checkLocalEngine(cfg, probes);
  return checkCloudKey(active, probes);
}
