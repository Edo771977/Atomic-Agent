/**
 * Which registered tools READ the filesystem, and which of their
 * arguments name what they read. Shared by the session read scope and
 * the narrower fusion-worker one (`read-scope.ts`).
 */

import { dirname, isAbsolute, join } from "node:path";
import { resolveScriptCwd } from "../os/shell/org-script-operands.js";
import { fileURLToPath } from "node:url";
import { resolveUserPath } from "../os/expand-home.js";

import { stdinScriptOf } from "../os/shell/shell-command-argv.js";
import { needsShellInterpretation } from "../os/shell/shell-interpretation.js";
import { imagePathsOf } from "../os/office/docx-xml.js";

export type ReadTargetsOf = (args: Record<string, unknown>) => string[];

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const pathArg: ReadTargetsOf = (args) => {
  const path = nonEmpty(args.path);
  return path === undefined ? [] : [path];
};

/**
 * The local file a browser URL opens (`file:///…`, also behind
 * `view-source:`), or `null` for any other URL. A browser page on a
 * local file is a read like `os.fs.read`.
 */
type LocalFileUrl = { path: string } | { error: string } | null;

function parseLocalFileUrl(url: string): LocalFileUrl {
  // WHATWG URL parsing removes HT/LF/CR, including inside a scheme.
  // Inspect the parsed protocol at every wrapper, rather than a raw
  // prefix that misses `view-\tsource:` while the browser accepts it.
  let rest = url.trim().replace(/[\t\r\n]/g, "");
  let parsed: URL;
  for (;;) {
    try {
      parsed = new URL(rest);
    } catch {
      return /^file:/i.test(rest) ? { error: "has an invalid local file URL" } : null;
    }
    if (parsed.protocol !== "view-source:") break;
    rest = parsed.pathname.trim();
  }
  if (parsed.protocol !== "file:") return null;
  try {
    const path = fileURLToPath(parsed);
    // Node permits NUL in the decoded string, but no filesystem API can
    // open it. Windows also forbids the remaining ASCII control bytes.
    if ((process.platform === "win32" ? /[\x00-\x1f]/ : /\x00/).test(path)) {
      return { error: "has an invalid local file path" };
    }
    return { path };
  } catch {
    // A drive-less Windows URL, foreign file host, invalid escape or
    // encoded separator cannot be checked as a native path. Never drop
    // its host/drive semantics and let a browser resolve it differently.
    return { error: "cannot be mapped to an absolute local path on this platform" };
  }
}

export function localFileOfUrl(url: string): string | null {
  const local = parseLocalFileUrl(url);
  return local !== null && "path" in local ? local.path : null;
}

/** A local URL the browser must refuse, rather than opening unchecked. */
export function invalidLocalFileUrlReason(url: string): string | null {
  const local = parseLocalFileUrl(url);
  return local !== null && "error" in local ? local.error : null;
}

const NON_FILE_READ_PROTOCOLS = new Set(["http:", "https:", "data:", "blob:", "about:"]);

/** Shell arguments are paths unless they are unambiguous HTTP(S) URLs. */
export function isShellHttpUrl(value: string): boolean {
  if (!/^https?:\/\/[^/?#\\\s]+/i.test(value) || /[\s\\]/.test(value)) return false;
  // WHATWG URL parsing removes these segments. Check the original token
  // first because it could also name a relative filesystem path.
  if (value.split("/").some(segment => /^(?:\.|%2e){2}(?:[?#].*)?$/i.test(segment))) return false;
  try {
    const url = new URL(value);
    return url.hostname.length > 0;
  } catch {
    return false;
  }
}

export function isNonFileReadUrl(value: string): boolean {
  let rest = value.trim();
  try {
    let url = new URL(rest);
    while (url.protocol === "view-source:") {
      rest = url.pathname.trim();
      url = new URL(rest);
    }
    if (url.protocol === "http:" || url.protocol === "https:") {
      return /^https?:\/\//i.test(rest) && url.hostname.length > 0;
    }
    return NON_FILE_READ_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Check the decoded target of a file URL and the lexical target an
 * ordinary path consumer would open. URL-capable tools remove non-file
 * URLs before calling this helper. A pathname such as "folder:name"
 * must still go through the same resolver as the filesystem tools.
 */
export function readTargetPaths(target: string, workingDir: string): string[] {
  const file = localFileOfUrl(target);
  try {
    const path = resolveUserPath(target, workingDir);
    return file === null || file === path ? [path] : [file, path];
  } catch {
    return file === null ? [] : [file];
  }
}

/** URL reads share argument selection between validation and path extraction. */
const URL_READ_TARGETS: ReadonlyMap<string, (args: Record<string, unknown>) => string | undefined> = new Map([
  ["browser.navigate", (args) => nonEmpty(args.url)],
  ["browser.tabs", (args) => args.action === "new" ? nonEmpty(args.url) : undefined],
]);

/** Invalid local URLs must not become an empty, implicitly allowed target set. */
export function invalidReadUrlTarget(
  tool: string,
  args: Record<string, unknown>,
): { url: string; why: string } | null {
  const url = URL_READ_TARGETS.get(tool)?.(args);
  if (url === undefined) return null;
  const why = invalidLocalFileUrlReason(url);
  return why === null ? null : { url, why };
}

function gitRepoArg(pathKey?: "path" | "paths"): ReadTargetsOf {
  return (args) => {
    const targets: string[] = [];
    const repo = nonEmpty(args.repo);
    if (repo !== undefined) targets.push(repo);
    if (pathKey !== undefined) {
      const raw = args[pathKey];
      const paths = Array.isArray(raw) ? raw.map(nonEmpty) : [nonEmpty(raw)];
      // git runs in `repo` (or the working directory), so a relative
      // pathspec names a file under it: `../` climbs out like any read.
      for (const path of paths) {
        if (path === undefined) continue;
        targets.push(isAbsolute(path) || repo === undefined ? path : join(repo, path));
      }
    }
    return targets;
  };
}

/**
 * The local repository an `os.git.clone` copies (issue #74 item 10): a
 * path or a `file://` url. git runs in the destination's parent, so a
 * relative path is resolved from there. A remote url (`scheme://`, the
 * scp-like `host:path`) reads nothing here.
 */
const gitCloneSource: ReadTargetsOf = (args) => {
  const url = nonEmpty(args.url);
  if (url === undefined) return [];
  if (/^file:/i.test(url)) {
    const file = localFileOfUrl(url);
    return file === null ? [] : [file];
  }
  const drive = /^[A-Za-z]:[\\/]/.test(url);
  if (URL_LIKE.test(url) && !drive) return [];
  const colon = url.indexOf(":");
  const slash = url.search(/[\\/]/);
  if (!drive && colon > 0 && (slash === -1 || colon < slash)) return [];
  const dest = nonEmpty(args.dest);
  return [isAbsolute(url) || drive || url.startsWith("~") || dest === undefined ? url : join(dirname(dest), url)];
};

/**
 * The read-class filesystem tools and the argument(s) naming what they
 * read. A search tool's omitted root is the working directory, which is
 * inside by definition, so it contributes nothing to check.
 */
export const READ_TOOL_TARGETS: ReadonlyMap<string, ReadTargetsOf> = new Map<
  string,
  ReadTargetsOf
>([
  ["os.fs.read", pathArg],
  ["os.fs.list", pathArg],
  ["os.fs.hash", pathArg],
  ["os.fs.watch", pathArg],
  ["os.fs.read_document", pathArg],
  // The office tools read the file they edit or show; `create` makes a
  // new one, which the approval ladder classifies as a write.
  [
    // The document itself (not for create), and every picture its
    // `![alt](path)` blocks embed: a file from outside the scope put in a
    // document inside it could otherwise be read without asking.
    "os.fs.docx",
    (args) => [
      ...(args.op === "create" ? [] : pathArg(args)),
      ...imagePathsOf(
        (Array.isArray(args.blocks) ? args.blocks : []).filter(
          (block: unknown): block is string => typeof block === "string",
        ),
      ),
    ],
  ],
  ["os.fs.xlsx", (args) => (args.op === "create" ? [] : pathArg(args))],
  ["os.fs.archive.list", pathArg],
  ["os.fs.archive.read_entry", pathArg],
  ["os.fs.grep", pathArg],
  // A folder to map or one file to outline; omitted = the working dir.
  ["os.fs.code_map", pathArg],
  // Both read what they search (ATO-696); the rewrite then asks to write.
  ["os.code.search", pathArg],
  ["os.code.rewrite", pathArg],
  [
    "os.fs.glob",
    // `cwd` wins over `path` inside the tool; either names the root.
    (args) => {
      const root = nonEmpty(args.cwd) ?? nonEmpty(args.path);
      return root === undefined ? [] : [root];
    },
  ],
  [
    "os.fs.diff",
    (args) =>
      [nonEmpty(args.aPath), nonEmpty(args.bPath)].filter(
        (path): path is string => path !== undefined,
      ),
  ],
  [
    // Not a read, but a way to one: a picture from outside the scope
    // embedded in a deck inside it could then be read without asking.
    // The deck itself is a write, which the approval ladder classifies.
    "os.fs.write_pptx",
    (args) =>
      (Array.isArray(args.slides) ? args.slides : [])
        .map((slide: unknown) =>
          typeof slide === "object" && slide !== null
            ? nonEmpty((slide as Record<string, unknown>).image)
            : undefined,
        )
        .filter((path): path is string => path !== undefined),
  ],
  [
    "vision.describe",
    (args) =>
      [
        nonEmpty(args.path),
        ...(Array.isArray(args.paths) ? args.paths.map(nonEmpty) : []),
      ].filter((path): path is string => path !== undefined),
  ],
  // The clip is read from disk and sent to the model (ATO-497).
  ["audio.listen", pathArg],
  [
    // `browser.act { action: "upload" }` reads local files and sends
    // them to a site (ATO-957): scoped like any read, and the agent's
    // own secret files ask as `state_secret` before the upload prompt.
    "browser.act",
    (args) =>
      args.action !== "upload"
        ? []
        : [
            nonEmpty(args.path),
            ...(Array.isArray(args.paths) ? args.paths.map(nonEmpty) : [nonEmpty(args.paths)]),
          ].filter((path): path is string => path !== undefined),
  ],
  [
    // The first frame of an image-to-video clip: Core reads the file and
    // sends it to OpenRouter, so it is scoped like any read.
    "video.generate",
    (args) => {
      const image = nonEmpty(args.image);
      return image === undefined ? [] : [image];
    },
  ],
  // The page `video.render_html` records (ATO-1164).
  ["video.render_html", pathArg],
  [
    // whisper.cpp reads the recording: scoped like any read (ATO-702).
    "audio.transcribe",
    (args) => {
      const path = nonEmpty(args.path);
      return path === undefined ? [] : [path];
    },
  ],
  [
    // Not a read, but a way to one: a file moved from outside the scope
    // into the working directory could then be read without asking. Its
    // sources are checked like reads; destinations are writes, which the
    // approval ladder classifies.
    "os.fs.move",
    (args) =>
      (Array.isArray(args.moves) ? args.moves : [args])
        .map((item: unknown) =>
          typeof item === "object" && item !== null
            ? nonEmpty((item as Record<string, unknown>).from)
            : undefined,
        )
        .filter((path): path is string => path !== undefined),
  ],
  // The git read tools print file contents and history of whatever
  // repository `repo` names (omitted = the working directory). Pathspecs
  // are resolved against that repository; an absolute one is checked as
  // is. A revision cannot smuggle in a path: the tools refuse one that
  // starts with `-` (`revisionArg` in git-runner.ts).
  ["os.git.status", gitRepoArg()],
  ["os.git.branch", gitRepoArg()],
  ["os.git.show", gitRepoArg()],
  ["os.git.log", gitRepoArg("path")],
  ["os.git.blame", gitRepoArg("path")],
  ["os.git.diff", gitRepoArg("paths")],
  // A clone from a local path copies that repository's files and history.
  ["os.git.clone", gitCloneSource],
  // A file:// page (or its view-source:) reads that file into the
  // browser, and the page text comes back to the model.
  ...Array.from(URL_READ_TARGETS, ([name, urlOf]): [string, ReadTargetsOf] => [name, (args) => {
    const url = urlOf(args);
    if (url === undefined) return [];
    const file = parseLocalFileUrl(url);
    if (file !== null) return "path" in file ? [file.path] : [];
    return isNonFileReadUrl(url) ? [] : [url];
  }]),
  [
    // A syntax check reads every file it is handed.
    "verify.syntax",
    (args) =>
      (Array.isArray(args.files) ? args.files.map(nonEmpty) : []).filter(
        (path): path is string => path !== undefined,
      ),
  ],
]);

/** The shell tool, checked by token rather than by a named argument. */
export const SHELL_TOOL = "os.shell.run";

/** Runs a command like the shell does, so its commands get the shell's checks. */
export const VERIFY_TOOL = "verify.run";

/**
 * The commands a `verify.run` call would start, in the shape the shell
 * checks read (`{cmd, args}`). Taken from the raw arguments, whatever
 * the `kind`, because this runs before the tool validates them.
 */
export function verifyRunShellCalls(
  args: Record<string, unknown>,
  workingDir = process.cwd(),
): Record<string, unknown>[] {
  const calls: Record<string, unknown>[] = [];
  const cwd = resolveScriptCwd(typeof args.cwd === "string" ? args.cwd : undefined, workingDir);
  const scope = { ...(args.cwd === undefined ? {} : { cwd: args.cwd }), ...(args.env === undefined ? {} : { env: args.env }) };
  if (typeof args.cmd === "string") {
    calls.push({ cmd: args.cmd, args: args.args, ...scope });
    // A script a shell reads from `stdin` runs as that command line.
    const cmdArgs = Array.isArray(args.args) ? args.args.filter((a): a is string => typeof a === "string") : [];
    const stdin = typeof args.stdin === "string" ? args.stdin : undefined;
    for (const line of stdinScriptOf(args.cmd, cmdArgs, needsShellInterpretation(args.cmd, cmdArgs), stdin, cwd)?.lines ?? []) {
      calls.push({ cmd: line, ...scope });
    }
  }
  const start = args.start;
  if (typeof start === "object" && start !== null) {
    const { cmd, args: startArgs } = start as Record<string, unknown>;
    if (typeof cmd === "string") calls.push({ cmd, args: startArgs, ...scope });
  }
  return calls;
}

/** `https://…`, `data:…` — not a filesystem path, not this module's business. */
export const URL_LIKE = /^[a-z][a-z0-9+.-]*:(?:\/\/|[^\\/])/i;
