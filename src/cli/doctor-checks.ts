import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import { ConfigValidationError, parseUserConfigFile, projectConstraintNotices } from "../config/index.js";
import { readRawConfigTree } from "../config/config-paths.js";
import { describeSessionPinsFix, readSessionPins, SessionPinsReadError } from "../session/index.js";
import { WEBHOOK_SESSIONS_FILENAME } from "../http/webhook-session-store.js";
import { Database } from "../native/index.js";
import { checkCoreLocks } from "./doctor-core-lock.js";

/**
 * ATO-577 — `atag doctor`: a registry of checks, each of which can find one
 * kind of problem and, where the repair is bounded, offer a fix. A fix
 * either edits the raw config tree (the command backs the file up first and
 * `--undo` puts it back) or acts on the file itself (its mode). Nothing here
 * writes; the command does, and only under `--fix`.
 */
export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorFix {
  /** What the fix will do, said before it is done. */
  describe: string;
  /** Edits the raw config tree in place. */
  tree?: (tree: Record<string, unknown>) => void;
  /** Acts outside the tree (e.g. file mode). */
  file?: () => void;
}

export interface DoctorFinding {
  check: string;
  status: DoctorStatus;
  message: string;
  fix?: DoctorFix;
}

export interface DoctorContext {
  stateDir: string;
  configPath: string;
  platform: NodeJS.Platform;
  /** PATH lookup for a bare command; injectable for tests. */
  findOnPath: (command: string) => boolean;
  chmod: (path: string, mode: number) => void;
  /** Whether a process id is running; injectable for tests. */
  pidAlive: (pid: number) => boolean;
  now: () => Date;
  /**
   * Opens and closes a database; injectable for tests. Defaults to an
   * in-memory better-sqlite3 one. May return a detail for the ok line.
   */
  openSqlite?: () => string | void;
}

type Tree = Record<string, unknown>;

function asObject(value: unknown): Tree | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Tree) : null;
}

/** The config file reads as JSON and passes this build's schema. */
function checkConfig(ctx: DoctorContext): DoctorFinding[] {
  if (!existsSync(ctx.configPath)) {
    return [{ check: "config", status: "ok", message: `no ${ctx.configPath} yet; defaults apply` }];
  }
  let tree: Tree;
  try {
    tree = readRawConfigTree(ctx.configPath);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return [{ check: "config", status: "fail", message: `${why} (fix the file by hand; doctor does not guess at broken JSON)` }];
  }
  try {
    parseUserConfigFile(tree);
    return [{ check: "config", status: "ok", message: `${ctx.configPath} is valid` }];
  } catch (err) {
    if (!(err instanceof ConfigValidationError)) throw err;
    if (err.field === "llm.activeTextProvider") {
      const providers = Array.isArray(asObject(tree.llm)?.providers) ? (asObject(tree.llm)!.providers as unknown[]) : [];
      const first = providers.map(asObject).find((p) => typeof p?.id === "string")?.id as string | undefined;
      if (first) {
        return [{
          check: "config",
          status: "fail",
          message: `llm.activeTextProvider: ${err.reason}`,
          fix: {
            describe: `set llm.activeTextProvider to "${first}", the first configured provider`,
            tree: (t) => { asObject(t.llm)!.activeTextProvider = first; },
          },
        }];
      }
    }
    return [{ check: "config", status: "fail", message: `${err.field}: ${err.reason} (no automatic fix; \`atag config set\` or edit the file)` }];
  }
}

/**
 * `projects.constraints` (issue #33): one line per folder saying what it
 * allows and what is not policed, then the same warnings the load prints
 * (an unknown key inside an entry, an allowed provider that is not
 * configured). Only for a file that parses; `checkConfig` reports the rest.
 */
function checkProjectConstraints(ctx: DoctorContext): DoctorFinding[] {
  if (!existsSync(ctx.configPath)) return [];
  let parsed: ReturnType<typeof parseUserConfigFile>;
  let tree: Tree;
  try {
    tree = readRawConfigTree(ctx.configPath);
    parsed = parseUserConfigFile(tree);
  } catch {
    return [];
  }
  const raw = asObject(tree.projects)?.constraints;
  const known = parsed.llm?.providers.map((p) => p.id) ?? ["local-llama"];
  // What each folder allows, and, said plainly, what the dispatch guard
  // cannot see: programs a shell or script runs open their own sockets.
  const coverage: DoctorFinding[] = Object.entries(parsed.projects.constraints).map(([folder, entry]) => ({
    check: "project-constraints",
    status: "ok",
    message: `${folder} restricted to: ${entry.allowedProviders.length === 0 ? "no provider" : entry.allowedProviders.join(", ")}; ` +
      `egress allowed: ${(entry.allowedEgress ?? []).length === 0 ? "none" : entry.allowedEgress!.join(", ")}; ` +
      "best effort for shell commands (os.shell.run and verify.run refuse known network clients; scripts and other programs still open their own sockets); not covered: skill scripts and the network use of stdio MCP servers",
  }));
  return [
    ...coverage,
    ...projectConstraintNotices(raw, known).map((line) => ({
      check: "project-constraints",
      status: "warn" as const,
      message: line.replace(/^\[atomic-agent\] /, ""),
    })),
  ];
}

/** config.json holds API keys: readable by its owner only. */
function checkConfigMode(ctx: DoctorContext): DoctorFinding[] {
  if (ctx.platform === "win32" || !existsSync(ctx.configPath)) return [];
  const mode = statSync(ctx.configPath).mode & 0o777;
  if ((mode & 0o077) === 0) return [{ check: "config-mode", status: "ok", message: "config.json is readable by its owner only" }];
  return [{
    check: "config-mode",
    status: "warn",
    message: `config.json is mode ${mode.toString(8)}; other users on this computer can read the API keys in it`,
    fix: { describe: "chmod 600 config.json", file: () => ctx.chmod(ctx.configPath, 0o600) },
  }];
}

function commandExists(command: string, ctx: DoctorContext): boolean {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) return existsSync(command);
  return ctx.findOnPath(command);
}

/** An enabled stdio MCP server whose command is not installed fails every start. */
function checkMcpCommands(ctx: DoctorContext): DoctorFinding[] {
  let tree: Tree;
  try {
    tree = readRawConfigTree(ctx.configPath);
  } catch {
    return [];
  }
  const servers = asObject(tree.mcp)?.servers;
  if (!Array.isArray(servers)) return [];
  const out: DoctorFinding[] = [];
  servers.forEach((raw, i) => {
    const server = asObject(raw);
    const transport = asObject(server?.transport);
    // `enabled` goes through parseBool in the schema: "false", "0", "off", "no" are off too.
    const off = server?.enabled === false || (typeof server?.enabled === "string" && ["false", "0", "off", "no"].includes(server.enabled.toLowerCase()));
    if (!server || off || transport?.kind !== "stdio" || typeof transport.command !== "string") return;
    const name = typeof server.name === "string" ? server.name : `#${i}`;
    if (commandExists(transport.command, ctx)) {
      out.push({ check: "mcp", status: "ok", message: `${name}: ${transport.command} found` });
      return;
    }
    out.push({
      check: "mcp",
      status: "warn",
      message: `${name}: command "${transport.command}" is not installed, so this MCP server cannot start`,
      fix: {
        describe: `turn MCP server ${name} off (mcp.servers[${i}].enabled = false); install the command and turn it back on`,
        tree: (t) => {
          const s = asObject((asObject(t.mcp)?.servers as unknown[] | undefined)?.[i]);
          if (s) s.enabled = false;
        },
      },
    });
  });
  return out;
}

/**
 * Session retention skips its prune on every boot while a pin file exists
 * but cannot be read; only a log line says so. Reported here with the fix.
 */
function checkSessionPins(ctx: DoctorContext): DoctorFinding[] {
  try {
    readSessionPins({
      tasksDbFile: join(ctx.stateDir, "tasks.sqlite"),
      webhookSessionsFile: join(ctx.stateDir, WEBHOOK_SESSIONS_FILENAME),
    });
    return [];
  } catch (err) {
    if (!(err instanceof SessionPinsReadError)) throw err;
    return [{
      check: "session-pins",
      status: "warn",
      message: `${err.message}; session retention skips its prune every start until this is fixed. Fix: ${describeSessionPinsFix(err)}`,
    }];
  }
}

/**
 * Sessions, tasks and memory all live in SQLite. A native binding that never
 * built (npm blocked the install script, or Node was upgraded) fails every
 * command that opens a store; the loader's message carries the fix.
 */
function checkSqlite(ctx: DoctorContext): DoctorFinding[] {
  const open = ctx.openSqlite ?? openDefaultSqlite;
  try {
    const detail = open();
    const suffix = detail ? ` (${detail})` : "";
    return [{ check: "sqlite", status: "ok", message: `better-sqlite3 opens a database${suffix}` }];
  } catch (err) {
    return [{ check: "sqlite", status: "fail", message: err instanceof Error ? err.message : String(err) }];
  }
}

/**
 * Which native binding better-sqlite3 loads, in its own order: a locally
 * compiled `build/Release/better_sqlite3.node` first, else the prebuilt
 * N-API binary in `prebuilds/<platform>-<arch>.node` (issue #29: on 13.x the
 * compiled file is normally absent and that is fine).
 */
export function describeBetterSqliteBinding(
  packageDir: string,
  platform: NodeJS.Platform,
  arch: string,
  exists: (path: string) => boolean = existsSync,
): string {
  if (exists(join(packageDir, "build", "Release", "better_sqlite3.node"))) {
    return "compiled binding build/Release/better_sqlite3.node";
  }
  const targets = platform === "linux" ? [`linux-${arch}`, `linuxmusl-${arch}`] : [`${platform}-${arch}`];
  const found = targets.find((target) => exists(join(packageDir, "prebuilds", `${target}.node`)));
  return found ? `prebuilt binding prebuilds/${found}.node` : "no binding file found";
}

/** Opens an in-memory database and names the versions and the binding used. */
function openDefaultSqlite(): string {
  const db = new Database(":memory:");
  let sqliteVersion: string | undefined;
  try {
    const row = db.prepare("select sqlite_version() as v").get() as { v?: string } | undefined;
    sqliteVersion = row?.v;
  } finally {
    db.close();
  }
  const parts: string[] = [];
  try {
    const manifest = createRequire(import.meta.url).resolve("better-sqlite3/package.json");
    const version = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version;
    if (version) parts.push(`better-sqlite3 ${version}`);
    if (sqliteVersion) parts.push(`SQLite ${sqliteVersion}`);
    parts.push(describeBetterSqliteBinding(dirname(manifest), process.platform, process.arch));
  } catch {
    // The single-executable build carries the binding next to the exe, not a package dir.
    if (sqliteVersion) parts.push(`SQLite ${sqliteVersion}`);
  }
  return parts.join(", ");
}

export const DOCTOR_CHECKS: ReadonlyArray<(ctx: DoctorContext) => DoctorFinding[]> = [
  checkConfig,
  checkProjectConstraints,
  checkConfigMode,
  checkMcpCommands,
  checkCoreLocks,
  checkSessionPins,
  checkSqlite,
];

export function runDoctorChecks(ctx: DoctorContext): DoctorFinding[] {
  return DOCTOR_CHECKS.flatMap((check) => check(ctx));
}

/** `which`, without spawning: PATH entries (plus PATHEXT on Windows) that hold an executable file. */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const exts = platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        const path = join(dir, command + ext);
        accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
        if (statSync(path).isFile()) return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}
