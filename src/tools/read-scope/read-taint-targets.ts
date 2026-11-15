import { resolve } from "node:path";
import { resolveUserPath } from "../os/expand-home.js";
import { READ_TOOL_TARGETS, SHELL_TOOL, URL_LIKE } from "./read-scope-targets.js";
import { shellTokens } from "./read-scope-shell.js";

/**
 * The absolute paths a tool call reads, for the read taint of per-folder
 * provider constraints (issue #33 group C; runtime/session-read-taint.ts).
 *
 * Every read-class tool the read scope knows (`READ_TOOL_TARGETS`: the
 * fs read, list, grep and glob tools, read_document, archives, git
 * reads, `vision.describe`, a `file://` page, syntax checks), plus
 * `os.shell.run`: its `cwd` and every absolute or home-relative token of
 * the command. A search tool's omitted root is the working directory,
 * which the session's own folder policy already covers. A shell command
 * can still read a constrained folder through a relative path from a
 * `cwd` outside it, or a computed path; that is not detected.
 */
export function readTaintTargets(
  tool: string,
  args: Record<string, unknown>,
  workingDir: string,
): string[] {
  const raw: string[] = [];
  const targetsOf = READ_TOOL_TARGETS.get(tool);
  if (targetsOf !== undefined) raw.push(...targetsOf(args));
  if (tool === SHELL_TOOL) {
    if (typeof args.cwd === "string" && args.cwd.length > 0) raw.push(args.cwd);
    for (const token of shellTokens(args)) {
      const value = token.replace(/^['"]|['"]$/g, "").replace(/^[^=]*=(?=[~/]|[A-Za-z]:[\\/])/, "");
      if (/^(~[\\/]|\/(?!\/)|[A-Za-z]:[\\/])/.test(value)) raw.push(value);
    }
  }
  const out: string[] = [];
  for (const target of raw) {
    if (URL_LIKE.test(target)) continue;
    try {
      out.push(resolve(resolveUserPath(target, workingDir)));
    } catch {
      // Unresolvable here is unresolvable in the tool too.
    }
  }
  return [...new Set(out)];
}
