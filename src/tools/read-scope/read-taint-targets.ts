import { isAbsolute, join, resolve } from "node:path";
import { resolveUserPath } from "../os/expand-home.js";
import { READ_TOOL_TARGETS, SHELL_TOOL, URL_LIKE, VERIFY_TOOL, verifyRunShellCalls } from "./read-scope-targets.js";
import { shellTokens } from "./read-scope-shell.js";
import { serverForPath } from "../os/fs/lsp/lsp-servers.js";

/**
 * The absolute paths a tool call reads, for the read taint of per-folder
 * provider constraints (issue #33 group C; runtime/session-read-taint.ts).
 *
 * Every read-class tool the read scope knows (`READ_TOOL_TARGETS`: the
 * fs read, list, grep and glob tools, read_document, archives, git
 * reads, `vision.describe`, a `file://` page, syntax checks), the tools
 * below that return or move a file's content without being read-class
 * (`TAINT_ONLY_TARGETS`), plus `os.shell.run` and every command of
 * `verify.run`: its `cwd`, every absolute or home-relative token and
 * every relative token that climbs with `..` (resolved against the
 * `cwd`). A search tool's omitted root is the working directory, which
 * the session's own folder policy already covers. A shell command can
 * still read a constrained folder through a plain relative path from a
 * `cwd` outside it (`cd`, a script), or a computed path; that is not
 * detected.
 *
 * `options.lspWrites` says whether the after-edit language servers were
 * built at boot (`tools.lsp.enabled`); only then can an `os.fs.write`
 * result quote the project, so only then does a write taint.
 */
export function readTaintTargets(
  tool: string,
  args: Record<string, unknown>,
  workingDir: string,
  options: { lspWrites?: boolean } = {},
): string[] {
  const raw: string[] = [];
  if (tool === "os.fs.write") {
    const path = str(args.path);
    if (options.lspWrites === true && path !== undefined && serverForPath(path) !== null) raw.push(path);
  }
  const targetsOf = READ_TOOL_TARGETS.get(tool) ?? TAINT_ONLY_TARGETS.get(tool);
  if (targetsOf !== undefined) raw.push(...targetsOf(args));
  const calls = tool === SHELL_TOOL ? [args] : tool === VERIFY_TOOL ? verifyRunShellCalls(args) : [];
  for (const call of calls) {
    const given = typeof call.cwd === "string" && call.cwd.length > 0 ? resolveUserPath(call.cwd, workingDir) : undefined;
    if (given !== undefined) raw.push(given);
    const cwd = given ?? workingDir;
    for (const token of shellTokens({ ...call, cwd: undefined })) {
      const value = token.replace(/^['"]|['"]$/g, "").replace(/^[^=]*=(?=[~/.]|[A-Za-z]:[\\/])/, "");
      if (/^(~[\\/]|\/(?!\/)|[A-Za-z]:[\\/])/.test(value)) raw.push(value);
      else if (/(^|[\\/])\.\.([\\/]|$)/.test(value) && !URL_LIKE.test(value)) raw.push(resolve(cwd, value));
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

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const repoArg = (args: Record<string, unknown>): string[] => {
  const repo = str(args.repo);
  return repo === undefined ? [] : [repo];
};

/**
 * Tools that are not read-class for the read scope (they are writes,
 * approved as such) but still bring a file's content into the session
 * or send it on: an edit or patch returns a diff of the file, a restore
 * its checkpoint, an extraction copies an archive's entries out, and
 * the git mutations print the repository's files and history (a push
 * or fetch then sends them: tainting first lets the egress guard see
 * the repository's constraint). `os.fs.write` is handled in
 * `readTaintTargets`: it taints only when language servers exist.
 */
const TAINT_ONLY_TARGETS: ReadonlyMap<string, (args: Record<string, unknown>) => string[]> = new Map([
  ["os.fs.archive.extract", (args: Record<string, unknown>) => [str(args.path)].filter((p): p is string => p !== undefined)],
  ["os.fs.edit", (args: Record<string, unknown>) => [str(args.path)].filter((p): p is string => p !== undefined)],
  ["os.fs.restore", (args: Record<string, unknown>) => [str(args.path)].filter((p): p is string => p !== undefined)],
  [
    "os.fs.patch",
    (args: Record<string, unknown>) => {
      const root = str(args.rootDir);
      const patchPath = str(args.patchPath);
      const out = root === undefined ? [] : [root];
      // A patch path is relative to `rootDir`, not the working directory.
      if (patchPath !== undefined) out.push(isAbsolute(patchPath) || root === undefined ? patchPath : join(root, patchPath));
      return out;
    },
  ],
  ...["os.git.add", "os.git.commit", "os.git.checkout", "os.git.merge", "os.git.remote", "os.git.push", "os.git.pull", "os.git.fetch"]
    .map((name): [string, (args: Record<string, unknown>) => string[]] => [name, repoArg]),
]);
