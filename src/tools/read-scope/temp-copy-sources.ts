import { lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  makeProviderPolicy,
  providerPolicyFromStamp,
  resolveProjectConstraint,
  toProviderPolicyStamp,
  type ConstraintMatchOptions,
  type ProviderPolicy,
} from "../../config/project-constraint-match.js";
import type { ProjectConstraintsConfig } from "../../config/tool-config.js";
import { currentProviderPolicyFrame, intersectProviderPolicies } from "../../llm/provider-policy.js";
import { canonical, scratchDirs } from "./scratch-paths.js";

/**
 * Where a temp folder's content came from (issue #74 item 2).
 *
 * The runtime copies folders into the OS temp directory: fusion branch
 * workspaces and their patch stores (`atag-fusion-*`, private copies, not
 * git worktrees), `verify.run` copies (`atag-verify-*`), and the spill
 * folder of each session (`atomic-agent-tool-outputs/<session>/`). A
 * per-folder provider constraint matches none of them, so without this a
 * read of the copy carried no read taint, and the temp directory being
 * scratch let any session read another's copy unasked.
 *
 * Each such temp root gets a marker written when it is made, owner-only
 * (0600): `<root>/.atag-source.json`, or for a verify copy the sibling
 * `<root>.atag-source.json` (the copy itself is the workspace a check
 * runs in, and its `.git` may be the real one). It names the source
 * folder, the session that made it and that session's policy stamp at
 * the time. The marker is on disk, so it survives a restart for as long
 * as the folder does. Readers:
 *
 * - the read taint (`runtime/session-read-taint.ts`): a read inside the
 *   root taints with the source folder's constraint intersected with the
 *   stamp (`tempCopyPolicy`);
 * - the write-out guard (`tool-write-out.ts`): the root is governed by
 *   that same policy, and no file tool may write a marker;
 * - the read scope (`read-scope.ts`): a root that is not the caller's own
 *   is not scratch, so reading it asks like any read outside the roots.
 *
 * A root is recognised by its name directly under a scratch directory
 * (the exact names the runtime makes). A recognised root whose marker is
 * missing, malformed, a link or someone else's fails closed: restricted
 * to nothing, and foreign to every session. A fusion or verify marker
 * must name its source, and a marker this process wrote must still read
 * as written (an in-process record), so dropping a field or rewriting a
 * live root's marker fails closed too. A session's own spill folder is
 * its own when the folder's marker names it (its content came from that
 * session); ownership is never read from the folder's name. A shell
 * command can still rewrite the marker of a root another process made
 * (one from before a restart); deleting a marker fails closed.
 */

export const TEMP_COPY_MARKER = ".atag-source.json";
export const SPILL_BASE_NAME = "atomic-agent-tool-outputs";

const FUSION_RUN_ROOT = /^atag-fusion-[0-9a-f]{6}-[A-Za-z0-9]{6}$/;
const FUSION_PATCH_ROOT = /^atag-fusion-patch-[A-Za-z0-9]{6}$/;
const VERIFY_ROOT = /^atag-verify-[0-9a-f]{8}$/;
const MAX_SOURCE_HOPS = 4;

export type TempCopyKind = "fusion" | "verify" | "spill";

export interface TempCopyRoot {
  readonly kind: TempCopyKind;
  /** The temp root itself. */
  readonly dir: string;
  readonly markerPath: string;
}

export interface TempCopyMarker {
  readonly kind: TempCopyKind;
  /** The folder copied (fusion, verify). */
  readonly source?: string;
  /** The session that made the root. */
  readonly sessionId?: string;
  /** That session's policy when the root was made (or, for a spill folder, the strictest since). */
  readonly policy?: ProviderPolicy;
}

/** Who makes a temp root: the session and its policy. */
export interface TempCopyOwner {
  readonly sessionId?: string;
  readonly policy?: ProviderPolicy;
}

/** The marker path of a temp root of `kind` at `dir`. */
export function tempCopyMarkerPath(kind: TempCopyKind, dir: string): string {
  return kind === "verify" ? `${dir}${TEMP_COPY_MARKER}` : join(dir, TEMP_COPY_MARKER);
}

/** The owner of a root made now: the session and policy of the policy frame running. */
export function ambientTempCopyOwner(): TempCopyOwner {
  const frame = currentProviderPolicyFrame();
  return {
    ...(frame?.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
    ...(frame?.policy === undefined ? {} : { policy: frame.policy }),
  };
}

function partsUnder(base: string, path: string): string[] | undefined {
  const rel = relative(base, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(/[\\/]/);
}

function scratchBases(): string[] {
  return [...new Set(scratchDirs().flatMap((dir) => [resolve(dir), canonical(resolve(dir))]))];
}

/** The recognised temp root `path` lies in, or `undefined`. */
export function tempCopyRootOf(path: string): TempCopyRoot | undefined {
  const forms = [...new Set([resolve(path), canonical(resolve(path))])];
  for (const base of scratchBases()) {
    for (const form of forms) {
      const parts = partsUnder(base, form);
      if (parts === undefined) continue;
      const [first = "", second] = parts;
      if (FUSION_RUN_ROOT.test(first) || FUSION_PATCH_ROOT.test(first)) {
        const dir = join(base, first);
        return { kind: "fusion", dir, markerPath: tempCopyMarkerPath("fusion", dir) };
      }
      if (VERIFY_ROOT.test(first)) {
        const dir = join(base, first);
        return { kind: "verify", dir, markerPath: tempCopyMarkerPath("verify", dir) };
      }
      if (first === SPILL_BASE_NAME && second !== undefined && second.length > 0) {
        const dir = join(base, first, second);
        return { kind: "spill", dir, markerPath: tempCopyMarkerPath("spill", dir) };
      }
    }
  }
  return undefined;
}

/** Whether `path` is a temp root's marker (a file tool may never write one). */
export function isTempCopyMarkerPath(path: string): boolean {
  if (basename(path) !== TEMP_COPY_MARKER && !basename(path).endsWith(TEMP_COPY_MARKER)) return false;
  const full = resolve(path);
  const root = tempCopyRootOf(full);
  if (root !== undefined) return full === root.markerPath || canonical(full) === canonical(root.markerPath);
  // A verify copy's marker sits beside it.
  const name = basename(full).slice(0, -TEMP_COPY_MARKER.length);
  return VERIFY_ROOT.test(name) && tempCopyRootOf(join(dirname(full), name, "x"))?.kind === "verify";
}

/**
 * The markers this process wrote, by canonical path, with the exact text:
 * a marker of a root this process made that reads differently was
 * rewritten by something else (a shell command) and fails closed. One
 * entry per root made, for the life of the process.
 */
const writtenMarkers = new Map<string, string>();
const markerKey = (path: string): string => canonical(resolve(path));

/**
 * The marker at `markerPath` for a root of `kind`; `null` when missing or
 * unreadable (fail closed): a link, another user's, malformed, a fusion or
 * verify marker with no `source`, or one this process wrote whose text
 * changed since.
 */
export function readTempCopyMarkerAt(markerPath: string, kind: TempCopyKind): TempCopyMarker | null {
  try {
    const info = lstatSync(markerPath);
    if (!info.isFile()) return null;
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) return null;
    const text = readFileSync(markerPath, "utf8");
    const mine = writtenMarkers.get(markerKey(markerPath));
    if (mine !== undefined && mine !== text) return null;
    const raw = JSON.parse(text) as Record<string, unknown> | null;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (raw.version !== 1 || raw.kind !== kind) return null;
    const { source, sessionId } = raw;
    // A copy's marker exists to name its source: without one it is a spoof.
    if (kind !== "spill" && source === undefined) return null;
    if (source !== undefined && (typeof source !== "string" || !isAbsolute(source))) return null;
    if (sessionId !== undefined && typeof sessionId !== "string") return null;
    let policy: ProviderPolicy | undefined;
    if (raw.policy !== undefined) {
      policy = providerPolicyFromStamp(raw.policy);
      if (policy === undefined) return null;
    }
    return {
      kind,
      ...(source === undefined ? {} : { source }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(policy === undefined ? {} : { policy }),
    };
  } catch {
    return null;
  }
}

/** The temp root `path` lies in and its marker (`null`: unreadable), or `undefined` for any other path. */
export function tempCopyOf(path: string): { root: TempCopyRoot; marker: TempCopyMarker | null } | undefined {
  const root = tempCopyRootOf(path);
  if (root === undefined) return undefined;
  return { root, marker: readTempCopyMarkerAt(root.markerPath, root.kind) };
}

/**
 * Whether a spill folder is `sessionId`'s own: by its marker only, never
 * by its name (an older build's names were lossy: `codex:a.b` and
 * `codex:a_b` shared one). No readable marker: nobody's.
 */
function isOwnSpillRoot(copy: { root: TempCopyRoot; marker: TempCopyMarker | null }, sessionId: string | undefined): boolean {
  return copy.root.kind === "spill" && sessionId !== undefined && copy.marker?.sessionId === sessionId;
}

/** Whether `path` lies in a spill folder whose marker names `sessionId`. */
export function isOwnSpillPath(path: string, sessionId: string): boolean {
  const copy = tempCopyOf(path);
  return copy !== undefined && isOwnSpillRoot(copy, sessionId);
}

/**
 * Whether `path` lies in a recognised temp root that is not `sessionId`'s
 * own: made by another session, by nobody known, or with no readable
 * marker. Such a root is not scratch for the read scope.
 */
export function isForeignTempCopy(path: string, sessionId: string | undefined): boolean {
  const copy = tempCopyOf(path);
  if (copy === undefined) return false;
  if (isOwnSpillRoot(copy, sessionId)) return false;
  return copy.marker?.sessionId === undefined || copy.marker.sessionId !== sessionId;
}

function unreadablePolicy(dir: string): ProviderPolicy {
  return makeProviderPolicy({ key: `(unreadable temp copy marker) ${dir}`, allowedProviders: [], matchedDir: dir, readFrom: [dir] });
}

/**
 * The policy governing content inside a temp root: the source folder's
 * constraint (live config; a source that is itself a temp root resolves
 * through its own marker) intersected with the marker's stamp.
 * `undefined` outside a temp root, for a copy of an unconstrained folder
 * made by an unconstrained session, and for `sessionId`'s own spill
 * folder. A root with no readable marker is restricted to nothing.
 */
export function tempCopyPolicy(
  path: string,
  config: { projects: { constraints?: ProjectConstraintsConfig } },
  options: ConstraintMatchOptions & { sessionId?: string } = {},
  hops = 0,
): ProviderPolicy | undefined {
  const copy = tempCopyOf(path);
  if (copy === undefined) return undefined;
  if (isOwnSpillRoot(copy, options.sessionId)) return undefined;
  if (copy.marker === null || hops >= MAX_SOURCE_HOPS) return unreadablePolicy(copy.root.dir);
  let policy = copy.marker.policy;
  const source = copy.marker.source;
  if (source !== undefined) {
    const { sessionId: _ignored, ...match } = options;
    for (const part of [resolveProjectConstraint(config, source, match), tempCopyPolicy(source, config, match, hops + 1)]) {
      if (part !== undefined) policy = policy === undefined ? part : intersectProviderPolicies(policy, part);
    }
  }
  return policy;
}

function markerBody(kind: TempCopyKind, owner: TempCopyOwner & { source?: string }): string {
  return `${JSON.stringify({
    version: 1,
    kind,
    ...(owner.source === undefined ? {} : { source: owner.source }),
    ...(owner.sessionId === undefined ? {} : { sessionId: owner.sessionId }),
    ...(owner.policy === undefined ? {} : { policy: toProviderPolicyStamp(owner.policy) }),
  })}\n`;
}

/** Write a new root's marker (owner-only, never over an existing file). */
export async function writeTempCopyMarker(
  kind: TempCopyKind,
  dir: string,
  owner: TempCopyOwner & { source?: string },
): Promise<void> {
  const path = tempCopyMarkerPath(kind, dir);
  const body = markerBody(kind, owner);
  await writeFile(path, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  writtenMarkers.set(markerKey(path), body);
}

/** Write or replace a root's marker synchronously (owner-only); the spill folder's. */
export function writeTempCopyMarkerSync(
  kind: TempCopyKind,
  dir: string,
  owner: TempCopyOwner & { source?: string },
): void {
  const path = tempCopyMarkerPath(kind, dir);
  const body = markerBody(kind, owner);
  rmSync(path, { force: true });
  writeFileSync(path, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  writtenMarkers.set(markerKey(path), body);
}
