import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { ProjectConstraintsConfig } from "./tool-config.js";

/**
 * The provider policy of one session folder: which `projects.constraints`
 * entry governs it and the provider ids it allows. Plain data plus
 * `allows`, so it can be stamped (`toProviderPolicyStamp`) and rebuilt
 * (`providerPolicyFromStamp`) across a fusion worker's session metadata.
 */
export interface ProviderPolicy {
  /** The constraint entry as written in config (its folder key). */
  readonly key: string;
  /** Provider ids that may receive this folder's content. Empty: none. */
  readonly allowedProviders: readonly string[];
  /**
   * Egress classes (`EGRESS_CLASSES`, `mcp:<server>`) the folder's tools
   * may use to send content off this machine. Empty: none.
   */
  readonly allowedEgress: readonly string[];
  /** The session folder the entry matched. */
  readonly matchedDir: string;
  /**
   * Read taint (issue #33 group C): the constrained folders this
   * session read files from, when that is why the policy applies (an
   * unconstrained session that read inside one). Absent for a folder's
   * own constraint.
   */
  readonly readFrom?: readonly string[];
  /** Whether `providerId` (the ACTUAL provider about to be called) is allowed. */
  allows(providerId: string): boolean;
  /** Whether a tool of egress class `cls` may run. */
  allowsEgress(cls: string): boolean;
}

/** The serialisable form of a policy (no function). */
export interface ProviderPolicyStamp {
  key: string;
  allowedProviders: string[];
  allowedEgress: string[];
  matchedDir: string;
  readFrom?: string[];
}

/** Build a policy; an absent `allowedEgress` is none (fail closed). */
export function makeProviderPolicy(stamp: {
  key: string;
  allowedProviders: readonly string[];
  allowedEgress?: readonly string[];
  matchedDir: string;
  readFrom?: readonly string[] | undefined;
}): ProviderPolicy {
  const allowed = Object.freeze([...stamp.allowedProviders]);
  const egress = Object.freeze([...(stamp.allowedEgress ?? [])]);
  const readFrom = stamp.readFrom !== undefined && stamp.readFrom.length > 0
    ? Object.freeze([...stamp.readFrom])
    : undefined;
  return Object.freeze({
    key: stamp.key,
    allowedProviders: allowed,
    allowedEgress: egress,
    matchedDir: stamp.matchedDir,
    ...(readFrom === undefined ? {} : { readFrom }),
    allows: (providerId: string) => allowed.includes(providerId),
    allowsEgress: (cls: string) => egress.includes(cls),
  });
}

export function toProviderPolicyStamp(policy: ProviderPolicy): ProviderPolicyStamp {
  return {
    key: policy.key,
    allowedProviders: [...policy.allowedProviders],
    allowedEgress: [...policy.allowedEgress],
    matchedDir: policy.matchedDir,
    ...(policy.readFrom === undefined ? {} : { readFrom: [...policy.readFrom] }),
  };
}

/** Rebuild a stamped policy; anything malformed is `undefined` (the caller fails closed). */
export function providerPolicyFromStamp(raw: unknown): ProviderPolicy | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { key, allowedProviders, allowedEgress, matchedDir, readFrom } = raw as Record<string, unknown>;
  if (typeof key !== "string" || typeof matchedDir !== "string" || !Array.isArray(allowedProviders)) return undefined;
  if (!allowedProviders.every((id): id is string => typeof id === "string")) return undefined;
  if (readFrom !== undefined && !(Array.isArray(readFrom) && readFrom.every((dir): dir is string => typeof dir === "string"))) {
    return undefined;
  }
  // A stamp from before allowedEgress existed carries none: no egress.
  if (allowedEgress !== undefined
    && !(Array.isArray(allowedEgress) && allowedEgress.every((c): c is string => typeof c === "string"))) return undefined;
  return makeProviderPolicy({
    key,
    allowedProviders,
    ...(allowedEgress === undefined ? {} : { allowedEgress: allowedEgress as string[] }),
    matchedDir,
    readFrom: readFrom as string[] | undefined,
  });
}

type ConstraintSource = { projects: { constraints?: ProjectConstraintsConfig } };

/** Whether any folder is constrained: the guard then fails closed on a call with no policy frame. */
export function hasProjectConstraints(config: ConstraintSource): boolean {
  const c = config.projects.constraints;
  return c !== undefined && Object.keys(c).length > 0;
}

export interface ConstraintMatchOptions {
  /** Path rules to apply; default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Real path of an existing path, `undefined` when it cannot be read. Default `realpathSync.native`. */
  realpath?: (path: string) => string | undefined;
}

/**
 * The comparable form of a folder. Windows: `\\?\` and `\\?\UNC\` long
 * path prefixes stripped, `/` read as `\`, resolved, no trailing
 * separator except on a root (`c:\`), lower case (NTFS folders are case
 * insensitive). macOS: resolved, no trailing slash, lower case (APFS and
 * HFS+ are case-insensitive by default and `realpath` does not restore
 * the stored case of a path that was typed differently; on a
 * case-sensitive volume this only makes a constraint cover more, which
 * fails closed). Other POSIX: resolved, no trailing slash, case kept.
 */
export function normalizeConstraintPath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return posix.resolve(path).toLowerCase();
  if (platform !== "win32") return posix.resolve(path);
  let s = path.replace(/\//g, "\\");
  if (/^\\\\\?\\unc\\/i.test(s)) s = `\\\\${s.slice(8)}`;
  else if (s.startsWith("\\\\?\\")) s = s.slice(4);
  s = win32.resolve(s);
  if (s.length > win32.parse(s).root.length) s = s.replace(/\\+$/, "");
  return s.toLowerCase();
}

/** `child` is `parent` or inside it; a sibling sharing the prefix is not. */
function contains(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const p = platform === "win32" ? win32 : posix;
  const rel = p.relative(parent, child);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
}

function defaultRealpath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/**
 * The real form of `path`: its own real path, or for a path that does
 * not exist (yet) the real path of its nearest existing ancestor with
 * the rest appended, so a link above a new folder still resolves.
 */
function realForm(path: string, realpath: (p: string) => string | undefined, platform: NodeJS.Platform): string | undefined {
  const p = platform === "win32" ? win32 : posix;
  let current = path;
  const rest: string[] = [];
  for (let i = 0; i < 64; i += 1) {
    const real = realpath(current);
    if (real !== undefined) return rest.length === 0 ? real : p.join(real, ...rest.reverse());
    const parent = p.dirname(current);
    if (parent === current) return undefined;
    rest.push(p.basename(current));
    current = parent;
  }
  return undefined;
}

function formsOf(path: string, options: Required<ConstraintMatchOptions>): string[] {
  const forms = new Set<string>([normalizeConstraintPath(path, options.platform)]);
  const real = realForm(path, options.realpath, options.platform);
  if (real !== undefined) forms.add(normalizeConstraintPath(real, options.platform));
  return [...forms];
}

/**
 * Whether a `projects.constraints` folder lies strictly inside `dir`
 * (lexically or through real paths, like `resolveProjectConstraint`).
 * A tool that reads a whole tree from `dir` — a language server for a
 * repository (ATO-503) — would read that folder too, while the read
 * taint only sees `dir`, which no such entry covers.
 */
export function hasConstrainedFolderInside(
  config: ConstraintSource,
  dir: string,
  options: ConstraintMatchOptions = {},
): boolean {
  const constraints = config.projects.constraints;
  if (constraints === undefined) return false;
  const opts: Required<ConstraintMatchOptions> = {
    platform: options.platform ?? process.platform,
    realpath: options.realpath ?? defaultRealpath,
  };
  const dirForms = formsOf(dir, opts);
  return Object.keys(constraints).some((key) =>
    formsOf(key, opts).some((entry) =>
      dirForms.some((d) => d !== entry && contains(d, entry, opts.platform)),
    ),
  );
}

/**
 * The policy for a session working in `workingDir`, or `undefined` when
 * no `projects.constraints` entry covers it.
 *
 * An entry covers the folder itself and everything below it, never a
 * sibling that shares its prefix (`/work/a` does not cover `/work/ab`).
 * Both the entry and the folder are compared lexically AND through their
 * real paths (`realpathSync.native`, nearest existing ancestor for a
 * folder that does not exist), and any pairing that matches counts, so
 * a symlink or junction on either side cannot step around a constraint.
 * When several entries cover the folder, the most specific (longest)
 * wins. See `normalizeConstraintPath` for the Windows and macOS rules.
 */
export function resolveProjectConstraint(
  config: ConstraintSource,
  workingDir: string,
  options: ConstraintMatchOptions = {},
): ProviderPolicy | undefined {
  const constraints = config.projects.constraints;
  if (constraints === undefined) return undefined;
  const entries = Object.entries(constraints);
  if (entries.length === 0) return undefined;
  const opts: Required<ConstraintMatchOptions> = {
    platform: options.platform ?? process.platform,
    realpath: options.realpath ?? defaultRealpath,
  };
  const dirForms = formsOf(workingDir, opts);
  let best: { key: string; allowedProviders: readonly string[]; allowedEgress: readonly string[]; length: number } | undefined;
  for (const [key, entry] of entries) {
    let length = -1;
    for (const entryForm of formsOf(key, opts)) {
      if (dirForms.some((dir) => contains(entryForm, dir, opts.platform))) {
        length = Math.max(length, entryForm.length);
      }
    }
    if (length >= 0 && (best === undefined || length > best.length)) {
      best = { key, allowedProviders: entry.allowedProviders, allowedEgress: entry.allowedEgress ?? [], length };
    }
  }
  return best === undefined
    ? undefined
    : makeProviderPolicy({ key: best.key, allowedProviders: best.allowedProviders, allowedEgress: best.allowedEgress, matchedDir: workingDir });
}
