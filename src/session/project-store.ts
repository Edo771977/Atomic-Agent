import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";

import { normalizeProject, type ProjectState } from "./session-project.js";
import { renderProjectViews } from "./project-store-views.js";
import {
  canonicalJson,
  gateContentHash,
  gateDecided,
  insideFusionRuns,
  projectContent,
  resolveProject,
  type ProjectDecisionInput,
  type ProjectDecisionRecord,
  type ProjectRecordProblem,
  type ProjectRecordStore,
} from "./project-decisions.js";

/**
 * The fusion project's store in the project folder (issue #109):
 * `<folder>/.atomic/project/project.json` holds the whole project, with a
 * schema version, and is the source of truth; `BRIEF.md`, `PLAN.md` and
 * `STATUS.md` beside it are generated from it after every write and never
 * read back. Writes go through a temp file and a rename under a lock
 * file, compared on the stored `revision`, so a crash leaves the previous
 * valid JSON and two writers cannot both build on the same revision.
 *
 * The file holds the author content (and a readable mirror of the rest,
 * never read back): the runtime's state and the person's decisions live
 * in the state dir behind {@link ProjectRecordStore}
 * (`project-decisions.ts`), which this module reads to resolve the
 * project and writes on every change.
 */

export const PROJECT_STORE_DIR_PARTS = [".atomic", "project"] as const;
export const PROJECT_FILE_NAME = "project.json";
/** The one schema this build reads and writes; any other is refused, never overwritten. */
export const PROJECT_SCHEMA_VERSION = 1;
/** A lock older than this is a crashed writer's and is taken over. */
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 2_000;

/** The store folder of a project folder. */
export function projectStoreDir(folder: string): string {
  return join(folder, ...PROJECT_STORE_DIR_PARTS);
}

export function projectFilePath(folder: string): string {
  return join(projectStoreDir(folder), PROJECT_FILE_NAME);
}

/** One project as the file holds it. */
export interface StoredProject {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  /** Stable id, minted once. */
  id: string;
  /** A label; the folder's name at creation. */
  name: string;
  /** Absolute project folder (where the file was read, not a stored field). */
  folder: string;
  /** +1 on every write; a write names the revision it builds on. */
  revision: number;
  createdAt: number;
  updatedAt: number;
  project: ProjectState;
  /** Unknown top-level fields, kept verbatim on rewrite and never interpreted. */
  extra: Record<string, unknown>;
}

export type ProjectStoreProblemCode = "missing" | "damaged" | "unsupported-schema" | "exists" | "conflict" | "already-decided" | "locked" | "refused" | "record-unavailable" | "io";

export interface ProjectStoreProblem {
  code: ProjectStoreProblemCode;
  message: string;
}

export type ProjectStoreResult = { ok: true; stored: StoredProject } | { ok: false; problem: ProjectStoreProblem };

export interface ProjectStoreOptions {
  /** Attachment paths under it are written relative to it, and read back against it. */
  stateDir: string;
  /** Where the runtime's state and the person's decisions live ({@link ProjectRecordStore}). */
  records: ProjectRecordStore;
  now?: () => number;
}

/** A project opened for work: the file and the record it resolves against. */
export interface OpenedProject {
  stored: StoredProject;
  /** The record's project with an author edit of the file taken (`resolveProject`): what a chat works on. */
  project: ProjectState;
  /** The decision store's `seq` it was resolved at; a write names it. */
  decisionSeq: number;
  decisions: readonly ProjectDecisionRecord[];
}

export type ProjectOpenResult = { ok: true; opened: OpenedProject } | { ok: false; problem: ProjectStoreProblem };


const KNOWN_KEYS = new Set(["schemaVersion", "id", "name", "revision", "createdAt", "updatedAt", "project"]);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function problem(code: ProjectStoreProblemCode, message: string): { ok: false; problem: ProjectStoreProblem } {
  return { ok: false, problem: { code, message } };
}

/** Attachment paths: absolute under `stateDir` become relative (portable `/` form), and back. */
function mapAttachments(project: unknown, map: (path: string) => string | null): unknown {
  if (!isObject(project) || !Array.isArray(project.milestones)) return project;
  return {
    ...project,
    milestones: project.milestones.map((m) => {
      if (!isObject(m) || !Array.isArray(m.attachments)) return m;
      return {
        ...m,
        attachments: m.attachments.flatMap((a) => {
          if (!isObject(a) || typeof a.path !== "string") return [a];
          const path = map(a.path);
          return path === null ? [] : [{ ...a, path }];
        }),
      };
    }),
  };
}

function toFilePath(stateDir: string, path: string): string {
  const rel = relative(stateDir, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return path;
  return rel.split(sep).join("/");
}

/** A mirror's picture path back under the state dir; null (dropped) for an absolute path or one leaving `<stateDir>/fusion-runs`. */
function fromFilePath(stateDir: string, path: string): string | null {
  if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) return null;
  const resolved = join(stateDir, ...path.split("/"));
  return insideFusionRuns(stateDir, resolved) ? resolved : null;
}

/** The file read and checked for shape only (no decisions applied). */
export function readProjectFile(folder: string, options: Pick<ProjectStoreOptions, "stateDir">): ProjectStoreResult {
  const file = projectFilePath(folder);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return problem("missing", `No project in ${folder} (${file} does not exist).`);
    return problem("io", `${file} could not be read: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return problem("damaged", `${file} is not valid JSON (${(err as Error).message}). Fix or restore it; the project was not opened.`);
  }
  return parseProjectFile(raw, folder, options.stateDir);
}

/** A parsed `project.json` checked; exported for tests and readers that already hold the JSON. */
export function parseProjectFile(raw: unknown, folder: string, stateDir: string): ProjectStoreResult {
  const file = projectFilePath(folder);
  const damaged = (what: string) => problem("damaged", `${file} is damaged: ${what}. Fix or restore it; the project was not opened.`);
  if (!isObject(raw)) return damaged("it is not a JSON object");
  const version = raw.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) return damaged("schemaVersion is missing or not a whole number");
  if (version !== PROJECT_SCHEMA_VERSION) {
    return problem(
      "unsupported-schema",
      `${file} uses schema version ${version}; this Atomic Agent reads version ${PROJECT_SCHEMA_VERSION}. ` +
        (version > PROJECT_SCHEMA_VERSION ? "Update Atomic Agent to open it. " : "") +
        "The file was not opened and will not be overwritten.",
    );
  }
  if (typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) return damaged("id is missing or malformed");
  if (typeof raw.name !== "string") return damaged("name is missing");
  if (typeof raw.revision !== "number" || !Number.isInteger(raw.revision) || raw.revision < 1) return damaged("revision is not a whole number from 1");
  if (!isTime(raw.createdAt) || !isTime(raw.updatedAt)) return damaged("createdAt or updatedAt is not a time");
  const project = normalizeProject(mapAttachments(raw.project, (p) => fromFilePath(stateDir, p)));
  if (project === undefined) return damaged("the project (brief, plan, milestones or gate) does not read as a valid project");
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) if (!KNOWN_KEYS.has(key)) extra[key] = value;
  return {
    ok: true,
    stored: {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: raw.id,
      name: raw.name.slice(0, 160),
      folder,
      revision: raw.revision,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      project,
      extra,
    },
  };
}

/** The JSON object written for `stored`. */
export function projectFileJson(stored: StoredProject, stateDir: string): Record<string, unknown> {
  return {
    ...stored.extra,
    schemaVersion: stored.schemaVersion,
    id: stored.id,
    name: stored.name,
    revision: stored.revision,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    project: mapAttachments(stored.project, (p) => toFilePath(stateDir, p)),
  };
}

/** The file read and its decisions applied: what a chat opens. */
export function openProject(folder: string, options: ProjectStoreOptions): ProjectOpenResult {
  const read = readProjectFile(folder, options);
  if (!read.ok) return read;
  const record = options.records.read(read.stored.folder, read.stored.id);
  if (!record.ok) return { ok: false, problem: recordProblem(record.problem, read.stored.folder) };
  return {
    ok: true,
    opened: {
      stored: read.stored,
      project: resolveProject(read.stored.project, record.record, (options.now ?? Date.now)()),
      decisionSeq: record.record?.seq ?? 0,
      decisions: record.record?.decisions ?? [],
    },
  };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `fn` holding the store's lock file; `locked` when another writer keeps it. */
function withLock<T>(dir: string, now: () => number, fn: () => T): T | { ok: false; problem: ProjectStoreProblem } {
  const lock = join(dir, `${PROJECT_FILE_NAME}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return problem("io", `${lock} could not be created: ${(err as Error).message}`);
      try {
        if (now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) return problem("locked", `Another Atomic Agent is writing ${dir}; try again.`);
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Write `json` to `file` through a temp file and a rename. */
function writeAtomic(file: string, text: string): void {
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(temp, text, "utf8");
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** The views after the JSON landed; a failure here never undoes the write. */
function writeViews(stored: StoredProject, resolved: ProjectState): void {
  const dir = projectStoreDir(stored.folder);
  for (const [name, text] of Object.entries(renderProjectViews(stored, resolved))) {
    try {
      writeAtomic(join(dir, name), text);
    } catch {
      // The JSON is the source of truth; the next write regenerates them.
    }
  }
}

function writeFile(stored: StoredProject, options: ProjectStoreOptions): ProjectStoreProblem | null {
  try {
    writeAtomic(projectFilePath(stored.folder), `${JSON.stringify(projectFileJson(stored, options.stateDir), null, 2)}\n`);
    return null;
  } catch (err) {
    return { code: "io", message: `${projectFilePath(stored.folder)} could not be written: ${(err as Error).message}` };
  }
}

function recordProblem(p: ProjectRecordProblem, folder: string): ProjectStoreProblem {
  if (p.code === "already-decided" || p.code === "conflict" || p.code === "locked") return { code: p.code, message: p.message };
  // A record that cannot be read approves nothing and is never overwritten.
  return { code: "record-unavailable", message: `The project in ${folder} was not opened: its record in the state dir is unusable (${p.message}). Nothing was changed.` };
}

/**
 * A new project in `folder` from `project` (its content to the file, its
 * decisions, as a migrated session holds them, to the decision store);
 * refused when the folder already holds one (of any shape).
 */
export function createProject(folder: string, project: ProjectState, options: ProjectStoreOptions & { name?: string; id?: string }): ProjectOpenResult {
  const now = options.now ?? Date.now;
  const dir = projectStoreDir(folder);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return problem("io", `${dir} could not be created: ${(err as Error).message}`);
  }
  return withLock(dir, now, (): ProjectOpenResult => {
    const existing = readProjectFile(folder, options);
    if (existing.ok || existing.problem.code !== "missing") {
      return problem("exists", `${folder} already holds a project (${projectFilePath(folder)}); open it instead.`);
    }
    const at = now();
    const stored: StoredProject = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: options.id ?? randomUUID(),
      name: options.name ?? (basename(folder) || folder),
      folder,
      revision: 1,
      createdAt: at,
      updatedAt: at,
      project: projectContent(project),
      extra: {},
    };
    const prior = options.records.read(folder, stored.id);
    if (!prior.ok) return { ok: false, problem: recordProblem(prior.problem, folder) };
    // The record first: a crash before the file leaves no project (and a record nothing points at).
    const recorded = options.records.write(folder, stored.id, prior.record?.seq ?? 0, project);
    if (!recorded.ok) return { ok: false, problem: recordProblem(recorded.problem, folder) };
    const failed = writeFile(stored, options);
    if (failed !== null) return { ok: false, problem: failed };
    const opened = openProject(folder, options);
    if (opened.ok) writeViews(opened.opened.stored, opened.opened.project);
    return opened;
  });
}

/** Where a write builds from: the file's revision and the decision store's seq it read. */
export interface ProjectWriteBase {
  revision: number;
  decisionSeq: number;
}

/**
 * Write `project` (the resolved state a chat changed) on top of `base`:
 * read, compare, write, under the lock. The person's decision, when one
 * is given, is recorded bound to the content its gate covered in
 * `decidedOn` (the project it was taken on). Another chat's write since
 * `base` is `conflict`; the same gate decided again is
 * `already-decided`; a damaged or unsupported file is never overwritten.
 */
export function commitProject(
  folder: string,
  id: string,
  base: ProjectWriteBase,
  project: ProjectState,
  options: ProjectStoreOptions & { decision?: ProjectDecisionInput; decidedOn?: ProjectState },
): ProjectOpenResult {
  const now = options.now ?? Date.now;
  return withLock(projectStoreDir(folder), now, (): ProjectOpenResult => {
    const current = readProjectFile(folder, options);
    if (!current.ok) return current;
    if (current.stored.id !== id) return problem("refused", `${projectFilePath(folder)} holds another project (${current.stored.id}, not ${id}).`);
    const store = options.records;
    const decision = options.decision;
    const record = store.read(folder, id);
    if (!record.ok) return { ok: false, problem: recordProblem(record.problem, folder) };
    if (current.stored.revision !== base.revision) {
      if (decision !== undefined && gateDecided(record.record?.decisions ?? [], decision.gate, decision.version)) {
        return problem("already-decided", "That gate was already decided (in another chat); reload the project.");
      }
      return problem("conflict", `The project changed since it was read (revision ${current.stored.revision}, not ${base.revision}); reload it.`);
    }
    const hash = decision === undefined ? null : gateContentHash(options.decidedOn ?? project, decision.gate);
    const decided = decision === undefined || hash === null ? undefined : { ...decision, hash };
    // Refuse before touching the file; the record is checked again as it is written.
    if (decided !== undefined && (record.record?.decisions ?? []).some((d) => d.gate.kind === decided.gate.kind && canonicalJson(d.gate) === canonicalJson(decided.gate) && d.version === decided.version && d.hash === decided.hash)) {
      return problem("already-decided", "That gate was already decided (in another chat); reload the project.");
    }
    if ((record.record?.seq ?? 0) !== base.decisionSeq) {
      return problem("conflict", "The project's record changed since it was read; reload it.");
    }
    // No record for this folder: a copy, a moved folder or another
    // machine. It becomes its own project, under a new id, so its writes
    // can never reach the record of the folder it came from.
    const ownId = record.record === null ? randomUUID() : id;
    // The file first: a crash between leaves our own content in the file, which reads as an outside draft, never as an approval.
    const content = projectContent(project);
    if (ownId !== id || canonicalJson(content) !== canonicalJson(projectContent(current.stored.project))) {
      const failed = writeFile({ ...current.stored, id: ownId, revision: current.stored.revision + 1, updatedAt: Math.max(now(), current.stored.updatedAt), project: content }, options);
      if (failed !== null) return { ok: false, problem: failed };
    }
    const recorded = store.write(folder, ownId, ownId === id ? base.decisionSeq : 0, project, decided);
    if (!recorded.ok) return { ok: false, problem: recordProblem(recorded.problem, folder) };
    const opened = openProject(folder, options);
    if (opened.ok) writeViews(opened.opened.stored, opened.opened.project);
    return opened;
  });
}
