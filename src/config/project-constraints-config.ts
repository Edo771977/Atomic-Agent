import { posix, win32 } from "node:path";
import { emitConfigNoticeOnce } from "./config-primitives.js";
import { ConfigValidationError } from "./config-validation-error.js";
import type { ProjectConstraintsConfig } from "./tool-config.js";

export type { ProjectConstraintsConfig } from "./tool-config.js";

const FIELD = "projects.constraints";

/**
 * Parse `projects.constraints` (config v80): `{ "<absolute folder>":
 * { allowedProviders: string[] } }`. Fail closed: anything malformed —
 * a non-object block or entry, a relative or empty folder, a missing or
 * non-list `allowedProviders`, an empty or non-string id — is a
 * `ConfigValidationError`, so a typo can never quietly lift a constraint.
 * An empty list is valid and means no provider may serve the folder.
 *
 * Keys inside an entry other than `allowedProviders` are dropped here
 * (a newer build may add some, such as an egress list) and kept on disk
 * by the whole-file writer: `projects.constraints` is a dictionary
 * branch (`config-shape.ts`). The folder is kept as written; the
 * matcher normalises it. Whether a provider id names a configured
 * provider is checked by `noteUnknownConstraintProviders`, not here.
 */
export function parseProjectConstraints(
  raw: unknown,
  options: { platform?: NodeJS.Platform } = {},
): ProjectConstraintsConfig {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(FIELD, "expected an object of absolute folder → { allowedProviders }");
  }
  const isAbsolute = (options.platform ?? process.platform) === "win32" ? win32.isAbsolute : posix.isAbsolute;
  const out: ProjectConstraintsConfig = {};
  for (const [folder, entry] of Object.entries(raw as Record<string, unknown>)) {
    const field = `${FIELD}[${JSON.stringify(folder)}]`;
    if (folder.trim().length === 0 || !isAbsolute(folder)) {
      throw new ConfigValidationError(field, "the folder must be an absolute path");
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ConfigValidationError(field, "expected { allowedProviders: [...] }");
    }
    const list = (entry as { allowedProviders?: unknown }).allowedProviders;
    if (!Array.isArray(list)) {
      throw new ConfigValidationError(`${field}.allowedProviders`, "expected a list of provider ids");
    }
    const ids: string[] = [];
    for (const id of list) {
      if (typeof id !== "string" || id.trim().length === 0) {
        throw new ConfigValidationError(`${field}.allowedProviders`, "every provider id must be a non-empty string");
      }
      if (!ids.includes(id)) ids.push(id);
    }
    out[folder] = { allowedProviders: ids };
  }
  return out;
}

/**
 * Provider ids a constraint allows that name no configured provider.
 * They are kept (a provider added later starts matching) but never match
 * anything until then; one notice per id says so. `openrouter` is always
 * known: it is the id Core-proxied media is checked against.
 */
export function noteUnknownConstraintProviders(
  constraints: ProjectConstraintsConfig,
  knownProviderIds: readonly string[],
): void {
  for (const [folder, { allowedProviders }] of Object.entries(constraints)) {
    for (const id of allowedProviders) {
      if (id === "openrouter" || knownProviderIds.includes(id)) continue;
      emitConfigNoticeOnce(`[atomic-agent] ${FIELD}[${JSON.stringify(folder)}] allows provider ${JSON.stringify(id)}, which is not configured; it matches nothing until a provider with that id is added`);
    }
  }
}
