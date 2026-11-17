import { isAbsolute, posix, resolve, win32 } from "node:path";
import {
  normalizeConstraintPath,
  resolveProjectConstraint,
  type ConstraintMatchOptions,
  type ProviderPolicy,
} from "../config/project-constraint-match.js";
import type { ProjectConstraintsConfig } from "../config/tool-config.js";
import { resolveUserPath } from "./os/expand-home.js";

/**
 * Write-out rule of per-folder provider constraints (issue #33 §5): a
 * session whose effective policy is constrained (its own folder, or a
 * read taint) may write files only inside a folder whose own constraint
 * is the same entry or equal-or-stricter (its allowed providers AND its
 * allowed egress classes a subset of the session's). Otherwise a copy
 * written to an unconstrained folder would carry the content out of
 * reach of the read taint: the next session reading it would not be
 * tainted. See ../llm/docs/provider-policy.md#write-out.
 *
 * The one exception is a fusion worker's own temp copy (its working
 * directory under the fusion temp area): the worker obeys its parent's
 * stamped policy and its changes come back to the parent's folder.
 * Writes the runtime makes itself (traces, spill files, the session
 * store) are not tool calls and are not checked here. Shell commands
 * (`os.shell.run`, `verify.run`) can still write anywhere (a redirect,
 * `cp`); that is not detected.
 */

export const WRITE_OUT_NOT_ALLOWED_CODE = "ATOMIC_AGENT_WRITE_OUT_NOT_ALLOWED";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The paths a write tool would create or change, resolved against `workingDir`. */
export function writeTargetsOf(tool: string, args: Record<string, unknown>, workingDir: string): string[] {
  const raw: (string | undefined)[] = [];
  switch (tool) {
    case "os.fs.write":
    case "os.fs.edit":
    case "os.fs.restore":
      raw.push(str(args.path));
      break;
    case "os.fs.move":
      for (const item of Array.isArray(args.moves) ? args.moves : [args]) {
        if (typeof item === "object" && item !== null) raw.push(str((item as Record<string, unknown>).to));
      }
      break;
    case "os.fs.archive.extract":
      raw.push(str(args.destDir));
      break;
    case "os.fs.patch":
      // A dry run (the default) writes nothing.
      if (args.apply === true) raw.push(str(args.rootDir) ?? workingDir);
      break;
    // Upstream's office writers (merge 6d1f14fcd): every docx op writes,
    // an xlsx `read` does not.
    case "os.fs.docx":
    case "os.fs.write_pptx":
      raw.push(str(args.path));
      break;
    case "os.fs.xlsx":
      if (args.op !== "read") raw.push(str(args.path));
      break;
    // These save next to the session, never elsewhere: the working folder
    // (a video's `output` must stay inside it).
    case "video.render_html":
      raw.push(str(args.output) ?? workingDir);
      break;
    case "canvas.render":
      raw.push(workingDir);
      break;
    // ast-grep's rewrite (ATO-1187) writes every changed file under `path`
    // only when applied; the dry run (the default) writes nothing.
    case "os.code.rewrite":
      if (args.apply === true) raw.push(str(args.path) ?? workingDir);
      break;
    default:
      return [];
  }
  const out: string[] = [];
  for (const target of raw) {
    if (target === undefined) continue;
    try {
      out.push(resolve(resolveUserPath(target, workingDir)));
    } catch {
      // The tool refuses an unresolvable path itself.
    }
  }
  return [...new Set(out)];
}

/** A write refused because it would take constrained content out of its folder. */
export class WriteOutNotAllowedError extends Error {
  readonly code = WRITE_OUT_NOT_ALLOWED_CODE;
  readonly tool: string;
  readonly target: string;
  readonly policyKey: string;

  constructor(tool: string, target: string, policy: ProviderPolicy) {
    const why = policy.readFrom !== undefined && policy.readFrom.length > 0
      ? `this session read files from ${policy.readFrom.join(", ")}, which is restricted`
      : `folder ${policy.key} is restricted`;
    super(
      `${why}: ${tool} would write its content to ${target}, outside every folder with the same or a stricter constraint; ` +
      "write inside the restricted folder instead",
    );
    this.name = "WriteOutNotAllowedError";
    this.tool = tool;
    this.target = target;
    this.policyKey = policy.key;
  }
}

/** Whether a folder governed by `target` may hold content governed by `session`. */
function holds(target: ProviderPolicy | undefined, session: ProviderPolicy): boolean {
  if (target === undefined) return false;
  if (target.key === session.key) return true;
  return target.allowedProviders.every((id) => session.allowedProviders.includes(id))
    && target.allowedEgress.every((cls) => session.allowedEgress.includes(cls))
    && target.allowedProviderHosts.every((host) => session.allowedProviderHosts.includes(host));
}

export interface WriteOutGuardDeps extends ConstraintMatchOptions {
  /** The session's effective policy (`effectivePolicyForSession`), `undefined` when unconstrained. */
  policyForSession: (sessionId: string) => ProviderPolicy | undefined;
  readConfig: () => { projects: { constraints?: ProjectConstraintsConfig } };
  /**
   * The folder this session may always write in although it is outside
   * every constraint: a fusion worker's own temp copy. `undefined` for
   * any other session.
   */
  ownScratchDir: (sessionId: string, workingDir: string) => string | undefined;
}

/** The dispatch guard: the refusal, or `null` when the write may go ahead. */
export function createWriteOutGuard(deps: WriteOutGuardDeps) {
  const platform = deps.platform ?? process.platform;
  const p = platform === "win32" ? win32 : posix;
  const inside = (parent: string, child: string): boolean => {
    const rel = p.relative(normalizeConstraintPath(parent, platform), normalizeConstraintPath(child, platform));
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${p.sep}`) && !isAbsolute(rel));
  };
  return (
    tool: string,
    args: Record<string, unknown>,
    ctx: { sessionId: string; workingDir?: string },
  ): WriteOutNotAllowedError | null => {
    const workingDir = ctx.workingDir ?? process.cwd();
    const targets = writeTargetsOf(tool, args, workingDir);
    if (targets.length === 0) return null;
    const policy = deps.policyForSession(ctx.sessionId);
    if (policy === undefined) return null;
    const config = deps.readConfig();
    const scratch = deps.ownScratchDir(ctx.sessionId, workingDir);
    const options: ConstraintMatchOptions = { platform, ...(deps.realpath === undefined ? {} : { realpath: deps.realpath }) };
    for (const target of targets) {
      if (scratch !== undefined && inside(scratch, target)) continue;
      if (!holds(resolveProjectConstraint(config, target, options), policy)) {
        return new WriteOutNotAllowedError(tool, target, policy);
      }
    }
    return null;
  };
}
