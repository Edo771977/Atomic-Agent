import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { systemPolicyPath } from "../config/org-policy-paths.js";
import { writeOwnerOnlyFileAtomicSync } from "../config/owner-only-file.js";
import { offlineRefusal } from "../llm/offline-network.js";
import { AGENT_TOOL_CHILD_ENV } from "../sandbox/command-env.js";
import type {
  EffectivePolicy,
  PolicySourceKind,
  PolicySourceStatus,
  SourcedPolicyRule,
} from "./policy-evaluator.js";
import { parsePolicyFile, parsePolicyText, PolicyFormatError, validatePolicyUrl, type PolicyFile } from "./policy-schema.js";

export { systemPolicyPath };

/** Env var naming a policy to fetch at start (like Goose's `GOOSE_ALLOWLIST`). */
export const POLICY_URL_ENV = "ATOMIC_POLICY_URL";
export const USER_POLICY_FILE = "policy.json";
export const POLICY_CACHE_FILE = "policy-cache.json";
const DEFAULT_FETCH_TIMEOUT_MS = 3_000;

export interface PolicyLoaderDeps {
  stateDir: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** File contents, or null when the file does not exist. Other errors throw. */
  readText?: (path: string) => string | null;
  writeText?: (path: string, text: string) => void;
  fetchText?: (url: string, timeoutMs: number) => Promise<string>;
  now?: () => Date;
  timeoutMs?: number;
}

export function userPolicyPath(stateDir: string): string {
  return join(stateDir, USER_POLICY_FILE);
}

/** A URL without its query and fragment, which may carry a token. */
export function redactPolicyUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}/…`;
  } catch {
    return "(invalid URL)";
  }
}

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function defaultWriteText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeOwnerOnlyFileAtomicSync(path, text);
}

async function defaultFetchText(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error", headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export interface LoadedPolicySource {
  status: PolicySourceStatus;
  file?: PolicyFile;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readFileSource(kind: PolicySourceKind, path: string, readText: (p: string) => string | null): LoadedPolicySource {
  try {
    const text = readText(path);
    if (text === null) return { status: { kind, location: path, state: "missing" } };
    return { status: { kind, location: path, state: "loaded" }, file: parsePolicyText(text) };
  } catch (err) {
    throw new PolicyFormatError(`Organization policy ${kind} file ${path} could not be loaded: ${errorText(err)}`);
  }
}

interface CacheEntry {
  url: string;
  fetchedAt: string;
  policy: unknown;
}

function readCache(deps: Required<Pick<PolicyLoaderDeps, "readText">> & PolicyLoaderDeps, url: string): { file: PolicyFile; fetchedAt: string } | null {
  try {
    const text = deps.readText(join(deps.stateDir, POLICY_CACHE_FILE));
    if (text === null) return null;
    const entry = JSON.parse(text) as Partial<CacheEntry>;
    // A copy cached for another URL is not this organisation's policy.
    if (entry.url !== url || typeof entry.fetchedAt !== "string") return null;
    return { file: parsePolicyFile(entry.policy), fetchedAt: entry.fetchedAt };
  } catch {
    return null;
  }
}

interface PolicyUrl {
  url: string;
  namedBy: "system" | "env";
}

// The cache is a file the user can write, which is fine: like every
// source it can only add asks, denies and allowlist limits.
function fromCache(deps: Required<Pick<PolicyLoaderDeps, "readText">> & PolicyLoaderDeps, target: PolicyUrl, error?: string): LoadedPolicySource {
  const base = { kind: "url" as const, location: redactPolicyUrl(target.url), namedBy: target.namedBy };
  const cached = readCache(deps, target.url);
  if (cached === null) {
    return { status: { ...base, state: "unreachable", ...(error ? { error } : {}) } };
  }
  return {
    status: { ...base, state: "cached", fetchedAt: cached.fetchedAt, ...(error ? { error } : {}) },
    file: cached.file,
  };
}

/**
 * Combine sources. Each keeps its own rules and allowlist; the evaluator
 * takes the strictest answer across them, so no source loosens another.
 */
export function mergePolicySources(loaded: readonly LoadedPolicySource[]): EffectivePolicy {
  const rules: SourcedPolicyRule[] = [];
  const mcpAllowlists: EffectivePolicy["mcpAllowlists"] = [];
  for (const { status, file } of loaded) {
    if (file === undefined) continue;
    file.rules.forEach((rule, index) => rules.push({ ...rule, source: status.kind, index }));
    if (file.mcpAllowlist !== undefined) mcpAllowlists.push({ ...file.mcpAllowlist, source: status.kind });
  }
  return { rules, mcpAllowlists, sources: loaded.map((l) => l.status) };
}

function withDefaults(deps: PolicyLoaderDeps) {
  if (process.env[AGENT_TOOL_CHILD_ENV] !== undefined || deps.env?.[AGENT_TOOL_CHILD_ENV] !== undefined) {
    throw new PolicyFormatError("Only the operator may load organization policy; an agent tool child cannot start a separate policy context");
  }
  return {
    ...deps,
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    readText: deps.readText ?? defaultReadText,
  };
}

function localSources(d: ReturnType<typeof withDefaults>): LoadedPolicySource[] {
  return [
    readFileSource("user", userPolicyPath(d.stateDir), d.readText),
    readFileSource("system", systemPolicyPath(d.platform, d.env), d.readText),
  ];
}

/**
 * The URL to fetch: the one the machine-wide file names, else
 * `ATOMIC_POLICY_URL`. A `url` in the user's own file is ignored.
 */
function policyUrl(env: NodeJS.ProcessEnv, local: readonly LoadedPolicySource[]): PolicyUrl | undefined {
  const fromSystem = local.find((l) => l.status.kind === "system")?.file?.url;
  if (fromSystem) return { url: validatePolicyUrl(fromSystem), namedBy: "system" };
  const fromEnv = env[POLICY_URL_ENV]?.trim();
  return fromEnv ? { url: validatePolicyUrl(fromEnv), namedBy: "env" } : undefined;
}

/**
 * The policy without network: both files plus the last fetched copy of
 * the policy URL. For short-lived commands (`skill install`, `policy
 * show`) and as the fallback before the runtime has fetched.
 */
export function loadLocalPolicy(deps: PolicyLoaderDeps): EffectivePolicy {
  const d = withDefaults(deps);
  const loaded = localSources(d);
  const url = policyUrl(d.env, loaded);
  if (url !== undefined) loaded.push(fromCache(d, url));
  return mergePolicySources(loaded);
}

/**
 * The policy at start: both files, then the policy URL (the machine-wide
 * file's `url`, else `ATOMIC_POLICY_URL`) fetched with a short timeout. A good copy is cached; when the fetch fails (offline, a
 * 500, bad JSON) the cached copy is used. Local file errors throw; remote fetches never wait longer
 * than the timeout: the upstream remote availability fallback is retained.
 */
export async function loadPolicy(deps: PolicyLoaderDeps): Promise<EffectivePolicy> {
  const d = withDefaults(deps);
  const loaded = localSources(d);
  const url = policyUrl(d.env, loaded);
  if (url !== undefined) loaded.push(await fetchSource(d, url));
  return mergePolicySources(loaded);
}

async function fetchSource(d: ReturnType<typeof withDefaults>, target: PolicyUrl): Promise<LoadedPolicySource> {
  const { url } = target;
  const fetchText = d.fetchText ?? defaultFetchText;
  let fetched: { raw: unknown; file: PolicyFile };
  try {
    const refused = offlineRefusal(url, "organization policy");
    if (refused !== null) throw refused;
    const raw: unknown = JSON.parse(await fetchText(url, d.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS));
    fetched = { raw, file: parsePolicyFile(raw) };
  } catch (err) {
    return fromCache(d, target, "Organization policy download or document unavailable");
  }
  const { raw, file } = fetched;
  const fetchedAt = (d.now?.() ?? new Date()).toISOString();
  try {
    const entry: CacheEntry = { url, fetchedAt, policy: raw };
    (d.writeText ?? defaultWriteText)(join(d.stateDir, POLICY_CACHE_FILE), `${JSON.stringify(entry, null, 2)}\n`);
  } catch {
    // An unwritable cache only costs the offline fallback next time.
  }
  return {
    status: { kind: "url", location: redactPolicyUrl(url), namedBy: target.namedBy, state: "loaded", fetchedAt },
    file,
  };
}
