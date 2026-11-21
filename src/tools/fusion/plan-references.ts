import { readFile, realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";

import { resolveRipgrepPath } from "../../runtime/ripgrep-resolver.js";
import { runCommand as defaultRunCommand, type CommandOptions, type CommandResult } from "../../sandbox/command-runner.js";
import type { AssignmentRow } from "../../session/session-project.js";
import type { ContractCheck } from "./contract.js";
import { REFERENCE_DETAIL_MAX, planReferenceBasis, type PlanReferenceRecord } from "./plan-checks.js";

/**
 * Issue #120: the files, `package.json` scripts, check commands and
 * backticked symbols a plan cites, resolved inside the project folder
 * before anything runs, so an invented or misspelt name is seen at the
 * plan gate instead of by a worker after the money is spent.
 *
 * Adapted from open-gsd/gsd-core's Plan Drift Guard (MIT,
 * `src/plan-drift-guard.cts`, `docs/adr/22-plan-drift-guard.md`): four
 * outcomes per reference (verified, missing, ambiguous, uncheckable) and
 * it never blocks; an unresolvable reference is "uncheckable", never green.
 *
 * Deterministic and model-free. It reads only inside the project folder
 * (stat, `package.json`, and ripgrep over the folder for symbols and bare
 * file names); a command is looked up on PATH by `stat` alone. A path,
 * cwd, package folder or `node_modules/.bin` whose real path (or its
 * nearest existing ancestor's) leads outside the folder is uncheckable
 * and nothing under it is stat-ed or read. It never
 * runs a project command and never uses the network: the only process it
 * starts is the bundled ripgrep binary.
 */

export type PlanReferenceKind = "file" | "script" | "command" | "symbol";
export type PlanReferenceOutcome = "verified" | "missing" | "ambiguous" | "uncheckable";

export interface PlanReference {
  kind: PlanReferenceKind;
  /** The name as cited: a project-relative path with `/`, a script or command name, an identifier. */
  value: string;
  /** Tasks citing it, plan order. */
  taskIds: string[];
  /** Where it is looked up, project-relative with `/` ("" is the folder itself); scripts and commands. */
  dir?: string;
  /** Why it cannot be checked, set at extraction (outside the folder). */
  reason?: string;
}

export interface ResolvedPlanReference extends PlanReference {
  outcome: PlanReferenceOutcome;
}

export interface PlanReferenceExtraction {
  references: PlanReference[];
  /** What the plan's tasks declare they create: project-relative paths and names (case-folded on win32). */
  created: Set<string>;
}

export interface PlanReferenceLimits {
  /** References resolved at most; the rest are uncheckable. */
  maxReferences: number;
  /** Wall time for the whole check. */
  maxMs: number;
  /** Files ripgrep may list in the folder; more and symbols and bare names are uncheckable. */
  maxFiles: number;
}

export const PLAN_REFERENCE_LIMITS: PlanReferenceLimits = { maxReferences: 60, maxMs: 2_000, maxFiles: 20_000 };

export interface PlanReferenceDeps {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  now: () => number;
  /** "file", "dir" or null for a path that does not exist (or cannot be read). */
  statPath: (path: string) => Promise<"file" | "dir" | null>;
  /** The real path, or null. */
  realPath: (path: string) => Promise<string | null>;
  /** The file's text when at most `maxBytes`, else null. */
  readText: (path: string, maxBytes: number) => Promise<string | null>;
  resolveRgPath: () => string | null;
  runCommand: (command: string, args: string[], options: CommandOptions) => Promise<CommandResult>;
}

export interface PlanReferenceOptions {
  /** The project folder: the session's working dir. */
  root: string;
  signal?: AbortSignal | undefined;
  limits?: Partial<PlanReferenceLimits>;
  deps?: Partial<PlanReferenceDeps>;
}

const defaultDeps = (): PlanReferenceDeps => ({
  platform: process.platform,
  env: process.env,
  now: Date.now,
  statPath: async (p) => {
    try {
      const s = await stat(p);
      return s.isDirectory() ? "dir" : s.isFile() ? "file" : null;
    } catch {
      return null;
    }
  },
  realPath: async (p) => {
    try {
      return await realpath(p);
    } catch {
      return null;
    }
  },
  readText: async (p, maxBytes) => {
    try {
      const s = await stat(p);
      if (!s.isFile() || s.size > maxBytes) return null;
      return await readFile(p, "utf8");
    } catch {
      return null;
    }
  },
  resolveRgPath: () => resolveRipgrepPath(),
  runCommand: defaultRunCommand,
});

// ------------------------------------------------------------------ extraction

/** Words that start a "this task creates …" clause in a task title. */
const CREATE_VERBS = new Set([
  "create", "creates", "creating", "add", "adds", "adding", "write", "writes", "writing", "new", "generate", "generates",
  "scaffold", "scaffolds", "introduce", "introduces", "define", "defines",
  "crea", "creare", "creo", "aggiungi", "aggiungere", "scrivi", "scrivere", "genera", "generare", "nuovo", "nuova", "nuovi", "nuove",
  "introduci", "definisci",
]);
/** Words that may sit between the verb and what it creates, or between listed names. */
const CREATE_FILLERS = new Set([
  "a", "an", "the", "and", "or", "new", "file", "files", "module", "modules", "function", "functions", "class", "classes", "method",
  "type", "interface", "helper", "component", "script", "scripts", "test", "tests", "folder", "directory", "called", "named", "npm",
  "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "e", "o", "funzione", "funzioni", "classe", "modulo", "moduli", "metodo",
  "componente", "cartella", "chiamato", "chiamata", "nuovo", "nuova",
]);
const SHELL_BUILTINS = new Set([
  "cd", "echo", "exit", "true", "false", "test", "set", "export", "printf", "pwd", "type", "exec", "eval", "source", ".", ":",
  "dir", "copy", "del", "call", "start", "ver", "cmd", "if", "for",
]);
/** npm/pnpm/yarn subcommands that are not a package.json script. */
const PM_BUILTINS = new Set([
  "install", "i", "ci", "add", "remove", "rm", "uninstall", "update", "up", "upgrade", "exec", "dlx", "x", "create", "init", "publish",
  "pack", "link", "unlink", "list", "ls", "outdated", "why", "audit", "config", "set", "get", "info", "view", "version", "help",
  "cache", "store", "prune", "dedupe", "rebuild", "import", "patch", "env", "bin", "root", "workspace", "workspaces", "node", "-v", "--version",
]);
const NPM_SCRIPT_ALIASES: Record<string, string> = { test: "test", t: "test", tst: "test", start: "start", stop: "stop", restart: "restart" };
const PM_DIR_FLAGS = new Set(["--prefix", "-C", "--dir", "--cwd"]);
/** A bare file name in a check's argv names a file only with one of these. */
const CODE_EXT = /\.(?:[cm]?[jt]sx?|json|py|rb|sh|ps1|html?|css|scss|md|ya?ml|toml|go|rs|java|kt|php|lua|sql|txt|csv)$/i;
const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;
const GLOB = /[*?[\]{}]/;

type PathModule = typeof posix;
const pathFor = (platform: NodeJS.Platform): PathModule => (platform === "win32" ? win32 : posix);
const fold = (s: string, platform: NodeJS.Platform): string => (platform === "win32" ? s.toLowerCase() : s);

/** A token that reads as a path: `a/b.ts`, `src\\x.js`, `dir/`; with `bare`, also `name.ext`. */
function pathLike(token: string, bare: boolean): boolean {
  if (token.length === 0 || token.length > 260 || token.includes("://") || GLOB.test(token) || /\s/.test(token)) return false;
  const t = token.replace(/\\/g, "/");
  if (t.includes("/")) {
    const last = t.replace(/\/+$/, "").split("/").pop() ?? "";
    if (t.endsWith("/")) return /^[\w@.-]+(?:\/[\w@.-]+)*\/$/.test(t.replace(/^\.\//, "").replace(/^[A-Za-z]:\//, "").replace(/^\/+/, ""));
    return /^[\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(last) && /^(?:[A-Za-z]:\/|\/|\.{1,2}\/)?(?:[\w@.-]+\/)*[\w@.-]+$/.test(t);
  }
  return bare && CODE_EXT.test(t) && /^[\w@.-]+$/.test(t) && !t.startsWith(".");
}

/**
 * A cited path as a project-relative `/` path, or the reason it is not
 * one (outside the folder). Absolute paths inside `root` are made relative.
 */
function relativeRef(raw: string, root: string, platform: NodeJS.Platform): { rel: string } | { outside: string } {
  const p = pathFor(platform);
  const slashed = raw.replace(/\\/g, "/");
  // `C:foo` is relative to drive C's current folder, not to the project.
  if (platform === "win32" && /^[A-Za-z]:(?!\/)/.test(slashed)) return { outside: raw };
  const absolute = rootedRef(raw, platform);
  let rel: string;
  if (absolute) {
    const r = p.relative(root, platform === "win32" ? slashed.replace(/\//g, "\\") : slashed).replace(/\\/g, "/");
    if (r === "" ) return { rel: "" };
    if (r.startsWith("..") || p.isAbsolute(r) || /^[A-Za-z]:/.test(r)) return { outside: raw };
    rel = r;
  } else {
    rel = posix.normalize(slashed);
  }
  rel = rel.replace(/^\.\//, "").replace(/\/+$/, "");
  if (rel === "." ) return { rel: "" };
  if (rel === ".." || rel.startsWith("../")) return { outside: raw };
  return { rel };
}

/** A path that names its own root (`/x`, `\\x`, and on win32 `C:\\x` or `C:x`): never joined under a cwd. */
function rootedRef(raw: string, platform: NodeJS.Platform): boolean {
  const slashed = raw.replace(/\\/g, "/");
  return slashed.startsWith("/") || (platform === "win32" && /^[A-Za-z]:/.test(slashed));
}

const trimPunct = (w: string): string => w.replace(/^[("'«“]+/, "").replace(/[)"'»”,;:!?]+$/, "").replace(/\.+$/, "");

interface Collector {
  add(kind: PlanReferenceKind, value: string, taskId: string, extra?: { dir?: string; reason?: string }): void;
  create(value: string): void;
}

/** A task title: paths, scripts, backticked symbols, and what a create clause names. */
function scanText(text: string, taskId: string, root: string, platform: NodeJS.Platform, out: Collector): void {
  const tokens = text.match(/`[^`\n]{1,200}`|\S+/g) ?? [];
  let creating = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const raw = tokens[i]!;
    const ticked = raw.startsWith("`") && raw.endsWith("`") && raw.length > 2;
    const word = ticked ? raw.slice(1, -1).trim() : trimPunct(raw);
    const lower = word.toLowerCase();
    // `npm run x`, `pnpm x`, `yarn x` written in the text.
    const pm = /^(npm|pnpm|yarn)$/i.test(word) ? word.toLowerCase() : null;
    if (pm !== null && !ticked) {
      const next = trimPunct(tokens[i + 1] ?? "").replace(/`/g, "");
      const after = trimPunct(tokens[i + 2] ?? "").replace(/`/g, "");
      const script = scriptOf(pm, next === "" ? [] : after === "" ? [next] : [next, after]);
      if (script !== null) {
        if (creating) out.create(`script:${script.name}`);
        else out.add("script", script.name, taskId, { dir: "" });
        i += script.consumed;
        continue;
      }
    }
    if (ticked && /\s/.test(word)) {
      // A backticked command line: its script, and the paths it names.
      const argv = word.split(/\s+/);
      const head = argv[0]!.toLowerCase();
      const script = /^(npm|pnpm|yarn)$/.test(head) ? scriptOf(head, argv.slice(1)) : null;
      if (script !== null) {
        if (creating) out.create(`script:${script.name}`);
        else out.add("script", script.name, taskId, { dir: "" });
      }
      for (const a of argv.slice(1)) if (pathLike(a, false)) addPath(a, taskId, root, platform, out, creating);
      creating = false;
      continue;
    }
    if (pathLike(word, ticked)) {
      addPath(word, taskId, root, platform, out, creating);
    } else if (ticked && IDENTIFIER.test(word)) {
      const name = word.replace(/\(\)$/, "").split(".").pop()!;
      if (creating) out.create(`symbol:${name}`);
      else if (name.length >= 3) out.add("symbol", name, taskId);
    } else if (ticked && /^[\w:.-]+$/.test(word) && creating) {
      // `test:xyz` after "add the script": a script this task adds.
      out.create(`script:${word}`);
    }
    const ends = !ticked && /[.;!?]$/.test(raw);
    if (CREATE_VERBS.has(lower) && !ticked) creating = true;
    else if (!(CREATE_FILLERS.has(lower) && !ticked) && !pathLike(word, ticked) && !(ticked && IDENTIFIER.test(word))) creating = false;
    if (ends) creating = false;
  }
}

/** `exact`: a check's argv path, relative to its cwd; a bare name in text may be anywhere in the folder. */
function addPath(raw: string, taskId: string, root: string, platform: NodeJS.Platform, out: Collector, creating: boolean, base = "", exact = false): void {
  const joined = base === "" || rootedRef(raw, platform) ? raw : `${base}/${raw}`;
  const ref = relativeRef(joined, root, platform);
  if ("outside" in ref) {
    if (!creating) out.add("file", ref.outside.replace(/\\/g, "/"), taskId, { reason: "outside the project folder (not read)" });
    return;
  }
  if (ref.rel === "") return;
  if (creating) out.create(`file:${ref.rel}`);
  else out.add("file", ref.rel, taskId, exact && !ref.rel.includes("/") ? { dir: "" } : {});
}

/** The script an npm/pnpm/yarn argv runs, with how many argv words it used, or null. */
function scriptOf(pm: string, argv: readonly string[]): { name: string; consumed: number; dir?: string } | null {
  let i = 0;
  let dir: string | undefined;
  while (i < argv.length && argv[i]!.startsWith("-")) {
    if (PM_DIR_FLAGS.has(argv[i]!) && argv[i + 1] !== undefined) {
      dir = argv[i + 1];
      i += 2;
    } else {
      i += 1;
    }
  }
  const sub = argv[i];
  if (sub === undefined) return null;
  const withDir = (name: string, consumed: number) => (dir === undefined ? { name, consumed } : { name, consumed, dir });
  if (sub === "run" || sub === "run-script" || (pm === "npm" && (sub === "rum" || sub === "urn"))) {
    const name = argv[i + 1];
    return name === undefined || name.startsWith("-") || !/^[\w:.@/-]+$/.test(name) ? null : withDir(name, i + 2);
  }
  if (pm === "npm") return NPM_SCRIPT_ALIASES[sub] === undefined ? null : withDir(NPM_SCRIPT_ALIASES[sub]!, i + 1);
  if (PM_BUILTINS.has(sub) || !/^[\w:.@-]+$/.test(sub)) return null;
  return withDir(sub, i + 1);
}

/** A check's argv: its command, args, `start`, `cwd` and page `path`. */
function scanCheck(check: ContractCheck, taskId: string, root: string, platform: NodeJS.Platform, out: Collector): void {
  const cwdRaw = typeof check.cwd === "string" && check.cwd.trim() !== "" ? check.cwd.trim() : "";
  let base = "";
  if (cwdRaw !== "") {
    const ref = relativeRef(cwdRaw, root, platform);
    if ("outside" in ref) {
      out.add("file", cwdRaw.replace(/\\/g, "/"), taskId, { reason: "outside the project folder (not read)" });
      return;
    }
    base = ref.rel;
    // A folder relative to the project root: resolved exactly, never searched for by name.
    if (base !== "") out.add("file", base, taskId, base.includes("/") ? {} : { dir: "" });
  }
  const start = typeof check.start === "object" && check.start !== null && !Array.isArray(check.start) ? check.start as Record<string, unknown> : undefined;
  const lines: Array<{ cmd: unknown; args: unknown }> = [
    { cmd: check.cmd ?? check.command, args: check.args },
    ...(start === undefined ? [] : [{ cmd: start.cmd ?? start.command, args: start.args }]),
  ];
  for (const line of lines) {
    if (typeof line.cmd !== "string" || line.cmd.trim() === "") continue;
    const words = line.cmd.trim().split(/\s+/);
    const argv = [...words.slice(1), ...(Array.isArray(line.args) ? line.args.filter((a): a is string => typeof a === "string") : [])];
    const head = words[0]!.replace(/^["']|["']$/g, "");
    const name = (head.replace(/\\/g, "/").split("/").pop() ?? head).replace(/\.(?:cmd|exe|bat)$/i, "").toLowerCase();
    if (/[\\/]/.test(head)) addPath(head, taskId, root, platform, out, false, base, true);
    else out.add("command", head, taskId, { dir: base });
    if (name === "npm" || name === "pnpm" || name === "yarn") {
      const script = scriptOf(name, argv);
      if (script !== null) {
        const dir = script.dir === undefined ? base : (() => {
          const r = relativeRef(base === "" || rootedRef(script.dir, platform) ? script.dir : `${base}/${script.dir}`, root, platform);
          return "rel" in r ? r.rel : null;
        })();
        if (dir === null) out.add("script", script.name, taskId, { reason: "its package folder is outside the project folder (not read)" });
        else out.add("script", script.name, taskId, { dir });
      }
      continue;
    }
    if (name === "npx") continue;
    for (const a of argv) if (!a.startsWith("-") && pathLike(a, true)) addPath(a, taskId, root, platform, out, false, base, true);
  }
  if (typeof check.path === "string" && pathLike(check.path, true)) addPath(check.path, taskId, root, platform, out, false, base, true);
}

/** Every reference the plan's tasks cite, and what they declare they create. Pure. */
export function extractPlanReferences(rows: readonly AssignmentRow[], root: string, platform: NodeJS.Platform = process.platform): PlanReferenceExtraction {
  const byKey = new Map<string, PlanReference>();
  const created = new Set<string>();
  const collector: Collector = {
    add(kind, value, taskId, extra = {}) {
      const key = fold(`${kind}:${extra.dir ?? ""}:${value}`, platform);
      const known = byKey.get(key);
      if (known !== undefined) {
        if (!known.taskIds.includes(taskId)) known.taskIds.push(taskId);
        return;
      }
      byKey.set(key, { kind, value, taskIds: [taskId], ...(extra.dir === undefined ? {} : { dir: extra.dir }), ...(extra.reason === undefined ? {} : { reason: extra.reason }) });
    },
    create(value) {
      created.add(fold(value, platform));
    },
  };
  for (const row of rows) {
    scanText(row.title, row.taskId, root, platform, collector);
    for (const check of row.checks ?? []) scanCheck(check, row.taskId, root, platform, collector);
  }
  return { references: [...byKey.values()], created };
}

// ------------------------------------------------------------------ resolution

/** Whether a task of the plan declares it creates this reference. */
function declaredCreated(ref: PlanReference, created: ReadonlySet<string>, platform: NodeJS.Platform): boolean {
  if (ref.kind === "file") {
    const v = fold(ref.value, platform);
    if (created.has(`file:${v}`)) return true;
    // A file inside a folder a task creates.
    for (const c of created) if (c.startsWith("file:") && v.startsWith(`${c.slice(5)}/`)) return true;
    return false;
  }
  if (ref.kind === "script") return created.has(fold(`script:${ref.value}`, platform));
  if (ref.kind === "symbol") return created.has(fold(`symbol:${ref.value}`, platform));
  return created.has(fold(`file:${ref.dir === undefined || ref.dir === "" ? ref.value : `${ref.dir}/${ref.value}`}`, platform));
}

interface Resolution {
  outcome: PlanReferenceOutcome;
  /** Why, for missing, ambiguous and uncheckable. */
  why?: string;
}

export interface PlanReferenceReport {
  record: PlanReferenceRecord;
  references: Array<ResolvedPlanReference & { why?: string }>;
  /** References skipped because a task declares it creates them. */
  declared: number;
}

/**
 * Resolve the plan's references inside `root` within the limits. Never
 * throws for a project problem; a cancelled signal leaves the rest
 * uncheckable.
 */
export async function checkPlanReferences(rows: readonly AssignmentRow[], options: PlanReferenceOptions): Promise<PlanReferenceReport> {
  const deps = { ...defaultDeps(), ...options.deps };
  const limits = { ...PLAN_REFERENCE_LIMITS, ...options.limits };
  const { platform } = deps;
  const p = pathFor(platform);
  const root = options.root;
  const deadline = deps.now() + limits.maxMs;
  const timeLeft = () => deadline - deps.now();
  const { references: all, created } = extractPlanReferences(rows, root, platform);
  const declared = all.filter((r) => declaredCreated(r, created, platform));
  const candidates = all.filter((r) => !declared.includes(r));
  const resolved = new Map<PlanReference, Resolution>();
  const over = candidates.slice(limits.maxReferences);
  for (const r of over) resolved.set(r, { outcome: "uncheckable", why: `over the limit of ${limits.maxReferences} references` });
  const work = candidates.slice(0, limits.maxReferences);
  const abs = (rel: string): string => (rel === "" ? root : p.join(root, ...rel.split("/")));
  const realRoot = (await deps.realPath(root)) ?? root;
  const inside = (real: string): boolean => {
    const r = p.relative(realRoot, real);
    return r === "" || (!r.startsWith("..") && !p.isAbsolute(r));
  };
  /**
   * Whether `rel` stays in the folder: the real path of it, or of its
   * nearest existing ancestor, is under the real root. Checked before
   * anything under it is stat-ed or read, so a symlink out of the folder
   * is never followed (nor used as an existence oracle).
   */
  const staysInside = async (rel: string): Promise<boolean> => {
    const parts = rel === "" ? [] : rel.split("/");
    for (let i = parts.length; i >= 0; i -= 1) {
      const at = parts.slice(0, i).join("/");
      if (i > 0 && (await deps.statPath(abs(at))) === null) continue;
      const real = await deps.realPath(abs(at));
      return real === null || inside(real);
    }
    return true;
  };
  const OUTSIDE_DIR = "its folder leads outside the project folder (not read)";
  const outOfTime = (): Resolution | null => {
    if (options.signal?.aborted === true) return { outcome: "uncheckable", why: "cancelled" };
    return timeLeft() <= 0 ? { outcome: "uncheckable", why: `time limit (${limits.maxMs} ms)` } : null;
  };

  // The folder's files, listed once by ripgrep when a bare name or a symbol needs it.
  const rgPath = work.some((r) => r.kind === "symbol" || (r.kind === "file" && !r.value.includes("/"))) ? deps.resolveRgPath() : null;
  let listing: { files: string[] } | { why: string } | undefined;
  const listFiles = async (): Promise<{ files: string[] } | { why: string }> => {
    if (listing !== undefined) return listing;
    if (rgPath === null) return (listing = { why: "ripgrep not found" });
    const late = outOfTime();
    if (late !== null) return (listing = { why: late.why! });
    const out = await deps.runCommand(rgPath, ["--no-config", "--files", "--glob", "!node_modules", "--glob", "!.atomic", "--", "."], {
      cwd: root, timeoutMs: Math.max(1, timeLeft()), maxOutputBytes: limits.maxFiles * 200, ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (out.timedOut) return (listing = { why: `time limit (${limits.maxMs} ms) listing the folder` });
    const files = out.stdout.split(/\r?\n/).filter((l) => l.length > 0).map((l) => l.replace(/\\/g, "/").replace(/^\.\//, ""));
    if (out.truncated || files.length > limits.maxFiles) return (listing = { why: `folder too large (over ${limits.maxFiles} files)` });
    if (out.exitCode !== 0 && out.exitCode !== 1) return (listing = { why: "ripgrep could not list the folder" });
    return (listing = { files });
  };

  const packages = new Map<string, Record<string, unknown> | "absent" | "unreadable" | "outside">();
  const scriptsOf = async (dir: string) => {
    const known = packages.get(dir);
    if (known !== undefined) return known;
    const rel = dir === "" ? "package.json" : `${dir}/package.json`;
    const file = abs(rel);
    let value: Record<string, unknown> | "absent" | "unreadable" | "outside";
    if (!(await staysInside(dir))) value = "outside";
    else if ((await deps.statPath(file)) !== "file") value = "absent";
    else if (!(await staysInside(rel))) value = "outside";
    else {
      const text = await deps.readText(file, 1024 * 1024);
      try {
        const parsed: unknown = text === null ? null : JSON.parse(text);
        const scripts = typeof parsed === "object" && parsed !== null ? (parsed as { scripts?: unknown }).scripts : undefined;
        value = text === null ? "unreadable" : typeof scripts === "object" && scripts !== null ? scripts as Record<string, unknown> : {};
      } catch {
        value = "unreadable";
      }
    }
    packages.set(dir, value);
    return value;
  };

  const resolveFile = async (rel: string, exact: boolean): Promise<Resolution> => {
    if (!rel.includes("/") && !exact) {
      if ((await deps.statPath(abs(rel))) !== null) return contained(rel);
      const listed = await listFiles();
      if ("why" in listed) return { outcome: "uncheckable", why: listed.why };
      const name = fold(rel, platform);
      const hits = listed.files.filter((f) => fold(f.split("/").pop() ?? f, platform) === name);
      if (hits.length === 0) return { outcome: "missing", why: "no file of that name outside ignored or hidden files" };
      if (hits.length === 1) return { outcome: "verified" };
      return { outcome: "ambiguous", why: `${hits.length} files have that name: ${hits.slice(0, 3).join(", ")}${hits.length > 3 ? ", …" : ""}` };
    }
    if (!(await staysInside(rel))) return { outcome: "uncheckable", why: "it leads outside the project folder" };
    if ((await deps.statPath(abs(rel))) === null) return { outcome: "missing", why: "not in the project folder" };
    return contained(rel);
  };
  // A path that exists but leads outside the folder (a symlink) is not read further.
  const contained = async (rel: string): Promise<Resolution> => {
    const real = await deps.realPath(abs(rel));
    return real === null || inside(real) ? { outcome: "verified" } : { outcome: "uncheckable", why: "it leads outside the project folder" };
  };

  const resolveCommand = async (ref: PlanReference): Promise<Resolution> => {
    const name = ref.value;
    if (SHELL_BUILTINS.has(name.toLowerCase())) return { outcome: "verified" };
    const exts = platform === "win32"
      ? ["", ...(deps.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0)]
      : [""];
    if (ref.dir !== undefined && ref.dir !== "" && !(await staysInside(ref.dir))) return { outcome: "uncheckable", why: OUTSIDE_DIR };
    const dirs = [...new Set([ref.dir ?? "", ""])];
    let binOutside = false;
    for (const d of dirs) {
      const binDir = d === "" ? "node_modules/.bin" : `${d}/node_modules/.bin`;
      if (!(await staysInside(binDir))) {
        binOutside = true;
        continue;
      }
      for (const ext of exts) {
        if ((await deps.statPath(abs(`${binDir}/${name}${ext}`))) === "file") return { outcome: "verified" };
      }
    }
    const pathVar = deps.env.PATH ?? deps.env.Path ?? deps.env.path ?? "";
    const entries = pathVar.split(platform === "win32" ? ";" : ":").filter((e) => e.length > 0 && p.isAbsolute(e)).slice(0, 64);
    for (const entry of entries) {
      for (const ext of exts) {
        if ((await deps.statPath(p.join(entry, name + ext))) === "file") return { outcome: "verified" };
      }
      const late = outOfTime();
      if (late !== null) return late;
    }
    return binOutside ? { outcome: "uncheckable", why: "node_modules/.bin leads outside the project folder" } : { outcome: "missing", why: "not on PATH nor in node_modules/.bin" };
  };

  const symbols = work.filter((r) => r.kind === "symbol" && r.reason === undefined);
  for (const ref of work) {
    if (ref.reason !== undefined) {
      resolved.set(ref, { outcome: "uncheckable", why: ref.reason });
      continue;
    }
    if (ref.kind === "symbol") continue;
    const late = outOfTime();
    if (late !== null) {
      resolved.set(ref, late);
      continue;
    }
    if (ref.kind === "file") resolved.set(ref, await resolveFile(ref.value, ref.dir !== undefined));
    else if (ref.kind === "command") resolved.set(ref, await resolveCommand(ref));
    else {
      const scripts = await scriptsOf(ref.dir ?? "");
      const where = ref.dir === undefined || ref.dir === "" ? "package.json" : `${ref.dir}/package.json`;
      resolved.set(ref, scripts === "outside" ? { outcome: "uncheckable", why: OUTSIDE_DIR }
        : scripts === "absent" ? { outcome: "missing", why: `no ${where}` }
        : scripts === "unreadable" ? { outcome: "uncheckable", why: `${where} could not be read` }
        : Object.hasOwn(scripts, ref.value) ? { outcome: "verified" } : { outcome: "missing", why: `no such script in ${where}` });
    }
  }

  if (symbols.length > 0) {
    const listed = await listFiles();
    const late = outOfTime();
    if ("why" in listed || late !== null) {
      for (const ref of symbols) resolved.set(ref, { outcome: "uncheckable", why: "why" in listed ? listed.why : late!.why! });
    } else {
      // One ripgrep over the folder for every symbol: fixed strings, whole words, matches only.
      // No --max-count: it caps matching lines per file over all patterns, hiding a later symbol;
      // the output cap bounds the search instead (over it: uncheckable).
      const args = ["--no-config", "--fixed-strings", "--word-regexp", "--only-matching", "--no-filename", "--no-line-number",
        "--max-filesize", "1M", "--glob", "!node_modules", "--glob", "!.atomic", ...symbols.flatMap((s) => ["-e", s.value]), "--", "."];
      const out = await deps.runCommand(rgPath!, args, {
        cwd: root, timeoutMs: Math.max(1, timeLeft()), maxOutputBytes: 1024 * 1024, ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const seen = new Set(out.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0));
      const incomplete = out.timedOut ? `time limit (${limits.maxMs} ms) searching the source`
        : out.truncated ? "the search output was over its limit"
        : out.exitCode !== 0 && out.exitCode !== 1 ? "ripgrep could not search the folder" : null;
      for (const ref of symbols) {
        resolved.set(ref, seen.has(ref.value) ? { outcome: "verified" }
          : incomplete !== null ? { outcome: "uncheckable", why: incomplete }
          : { outcome: "missing", why: "not found outside ignored, hidden or >1 MB files" });
      }
    }
  }

  const references = candidates.map((r) => {
    const res = resolved.get(r) ?? { outcome: "uncheckable" as const, why: "not resolved" };
    return { ...r, outcome: res.outcome, ...(res.why === undefined ? {} : { why: res.why }) };
  });
  return { record: summarize(references, declared.length, rows), references, declared: declared.length };
}

const label = (r: PlanReference): string =>
  r.kind === "file" ? r.value : r.kind === "script" ? `npm script ${r.value}` : r.kind === "command" ? `command ${r.value}` : `\`${r.value}\``;

/** The plan gate's line: missing and ambiguous with their tasks, the uncheckable summarized; green only when every one is verified. */
function summarize(refs: ReadonlyArray<ResolvedPlanReference & { why?: string }>, declared: number, rows: readonly AssignmentRow[]): PlanReferenceRecord {
  const by = (o: PlanReferenceOutcome) => refs.filter((r) => r.outcome === o);
  const missing = by("missing");
  const ambiguous = by("ambiguous");
  const unchecked = by("uncheckable");
  const verified = by("verified").length;
  const cite = (r: ResolvedPlanReference & { why?: string }) => `${label(r)} (${r.taskIds.join(", ")}${r.why === undefined ? "" : `: ${r.why}`})`;
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`Missing: ${missing.map(cite).join(", ")}. If a task creates one, say so in its title (create src/x.ts, add \`name\`).`);
  if (ambiguous.length > 0) parts.push(`Ambiguous: ${ambiguous.map(cite).join(", ")}.`);
  if (unchecked.length > 0) {
    const shown = unchecked.slice(0, 5).map((r) => `${label(r)} (${r.why ?? "not checked"})`).join(", ");
    parts.push(`${unchecked.length} reference${unchecked.length === 1 ? "" : "s"} not checked: ${shown}${unchecked.length > 5 ? ", …" : ""}.`);
  }
  const tail = `${verified} verified${declared > 0 ? `, ${declared} created by the plan` : ""}.`;
  const basis = planReferenceBasis(rows);
  if (parts.length === 0) {
    return {
      verdict: "pass",
      detail: refs.length === 0 && declared === 0 ? "The plan cites no file, script, command or symbol." : `Every cited file, script, command and symbol was found: ${tail}`,
      taskIds: [],
      basis,
    };
  }
  const taskIds = [...new Set([...missing, ...ambiguous].flatMap((r) => r.taskIds))];
  const detail = `${parts.join(" ")} ${tail}`;
  return { verdict: "warn", detail: detail.length <= REFERENCE_DETAIL_MAX ? detail : `${detail.slice(0, REFERENCE_DETAIL_MAX - 1)}…`, taskIds, basis };
}
