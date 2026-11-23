import { chmodSync, existsSync, lstatSync, type Stats } from "node:fs";
import { join } from "node:path";

import { restrictWindowsAcl } from "../config/windows-acl.js";
import { ensureSecretKeyFile } from "../local-llm/server/managed-api-key.js";

/**
 * The API key `atomic-agent serve` requires on every authenticated route.
 *
 * Serve never runs without one, on loopback too: any program on this
 * machine (a command the agent itself runs, a script, another user's
 * process) can reach a loopback port, and without a key it could drive
 * the agent and every tool it has. When the operator passes no key
 * (`--api-key`, `ATOMIC_AGENT_API_KEY`), serve uses the one in
 * `<stateDir>/serve-api.key`, generated on the first run and reused after,
 * the way Jupyter generates its token and LM Studio its API token.
 *
 * The file is written owner-only (0600, a restricted ACL on Windows) by
 * the same code that keeps the managed llama-server key
 * (`ensureSecretKeyFile`), and it is one of the agent's state secrets
 * (`getStateSecretPaths`), so an agent tool that reads it, or a shell
 * command that names it, is classified as state_secret. Full trust
 * (level 5) auto-approves that category.
 */

export const SERVE_API_KEY_FILE = "serve-api.key";

/** Where serve keeps the key it generated. */
export function serveApiKeyPath(stateDir: string): string {
  return join(stateDir, SERVE_API_KEY_FILE);
}

export type ServeApiKey =
  /** The operator's own key: `--api-key` or `ATOMIC_AGENT_API_KEY`. */
  | { readonly key: string; readonly source: "given" }
  /** The key in the state dir; `created` when this run wrote it. */
  | { readonly key: string; readonly source: "file"; readonly path: string; readonly created: boolean; readonly permissionsTightened?: boolean };

/** Allow a concurrent creator to unlink its temporary publication name. */
function singleLinkKeyFile(path: string): Stats | null {
  let entry = lstatSync(path);
  if (entry.isFile() && entry.nlink > 1) {
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (let retry = 0; retry < 5 && entry.nlink > 1; retry++) {
      Atomics.wait(wait, 0, 0, 10);
      entry = lstatSync(path);
    }
  }
  return entry.isFile() && entry.nlink === 1 ? entry : null;
}

function protectServeKey(path: string, onExposed: () => void): boolean {
  try {
    const entry = singleLinkKeyFile(path);
    if (!entry) return false;
    if (process.platform === "win32") return restrictWindowsAcl(path);
    if ((entry.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
    if ((entry.mode & 0o077) !== 0) onExposed();
    return true;
  } catch {
    return false;
  }
}

function hasSingleLink(path: string): boolean {
  try {
    return singleLinkKeyFile(path) !== null;
  } catch {
    return false;
  }
}

/**
 * The key serve runs with: the one given, else the persisted one (made on
 * first use). An error when there is none and the file can be neither read
 * nor written: serve then refuses to start rather than run without a key.
 */
export function resolveServeApiKey(
  given: string | null,
  stateDir: string,
): ServeApiKey | { readonly error: string } {
  if (given !== null) return { key: given, source: "given" };
  const path = serveApiKeyPath(stateDir);
  const existed = existsSync(path);
  let permissionsTightened = false;
  const key = ensureSecretKeyFile(path, file => protectServeKey(file, () => { permissionsTightened = true; }));
  if (key === null || !hasSingleLink(path)) {
    return {
      error:
        `no API key given, and the key file ${path} could not be read, created or restricted to the owner (symlinks and additional hard links are refused). ` +
        "Fix its permissions, or pass --api-key-file <path>, --api-key <token> or set ATOMIC_AGENT_API_KEY",
    };
  }
  return { key, source: "file", path, created: !existed, permissionsTightened };
}

/** Report where the operator can find the generated credential. */
export function serveApiKeyNotice(key: ServeApiKey, baseUrl: string): string {
  if (key.source === "given") return "";
  const warning = key.permissionsTightened
    ? "[atomic-agent] serve API key permissions were too broad. The key could have been read. To rotate it, stop serve, remove " + key.path + ", and restart.\n"
    : "";
  return warning + "[atomic-agent] serve API key " + (key.created ? "generated at " : "read from ") +
    key.path + "; use it as 'Authorization: Bearer <key>' or enter it at " + baseUrl + "/panel\n";
}
