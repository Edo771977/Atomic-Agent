import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, expect, it } from "vitest";

import { stateDirProjectRecords } from "../src/session/project-decisions.js";
import { createProject } from "../src/session/project-store.js";
import { normalizeProject } from "../src/session/session-project.js";
// @ts-expect-error -- plain .mjs script without declarations
import { buildReport, parseArgs } from "./e2e-artifacts.mjs";
// @ts-expect-error -- plain .mjs script without declarations
import { outcomeKey, sessionTag } from "./e2e-csv-sales.mjs";

const fixtures = fileURLToPath(new URL("../docs/testing/fixtures/", import.meta.url));
const entry = fileURLToPath(new URL("./e2e-artifacts.mjs", import.meta.url));
const sessionId = "artifact-fixture-session";
const reviewer = "reviewer:model";
const project = {
  brief: { status: "approved", version: 1 },
  plan: { status: "approved", version: 2, rows: [{ taskId: "write", title: "Write delivery", milestoneId: "m1", worker: "local:model", reviewer }] },
  gate: { kind: "none" },
  milestones: [{ id: "m1", title: "Deliver artifact", state: "reviewed", runIds: ["fr-m1"] }],
};
let dir: string;
let cwd: string;
let stateDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atomic-e2e-artifacts-"));
  cwd = join(dir, "project");
  stateDir = join(dir, "state");
  mkdirSync(cwd);
  mkdirSync(join(stateDir, "fusion"), { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function reportFile(kind: "document" | "spreadsheet", variant?: string) {
  const path = join(cwd, kind === "document" ? "report.md" : "sales.xlsx");
  copyFileSync(join(fixtures, kind, variant ?? (kind === "document" ? "live-report.md" : "sales.xlsx")), path);
  return path;
}

function stored(payload: object = { project }, workingDir = cwd) {
  const db = new DatabaseSync(join(stateDir, "sessions.sqlite"));
  try {
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, working_dir TEXT, status TEXT, payload TEXT, updated_at INTEGER)");
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)").run(sessionId, workingDir, "completed", JSON.stringify(payload), Date.now());
  } finally {
    db.close();
  }
}

function outcome({ count, status = "ok" }: { count?: number; status?: string } = {}) {
  writeFileSync(join(stateDir, "fusion", "outcomes.ndjson"), JSON.stringify({
    v: 1, type: "task", session: sessionTag(sessionId), ts: "2026-11-22T12:00:00.000Z",
    taskKey: outcomeKey("write"), milestoneKey: outcomeKey("m1"), status,
    provider: "local", model: "model", review: { decision: status === "ok" ? "accept" : "needs-changes", reviewer },
    ...(count === undefined ? {} : { candidate: { workerRuns: count } }),
  }) + "\n");
}

it("checks both real references and reports independently verified project evidence", async () => {
  stored();
  outcome({ count: 2 });
  for (const fixture of ["document", "spreadsheet"] as const) {
    reportFile(fixture);
    const result = await buildReport({ cwd, stateDir, session: sessionId, fixture });
    expect(result).toMatchObject({
      fixture, passed: true, blocking: [], artifact: { passed: true }, execution: { passed: true },
      workerExecutions: { count: 2, known: 2, taskRecords: 1, withoutCounts: 0 },
    });
    expect(result.artifact.checks).toHaveLength(4);
    expect(result.artifact.checks.every((check: { status: string }) => check.status === "pass")).toBe(true);
  }
});

it("names missing Italian headings and placeholders without relying on session evidence", async () => {
  const path = reportFile("document");
  const original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace("## Prossimi passi", "## Sviluppi") + "\n[inserire]\n");
  const result = await buildReport({ cwd, stateDir, fixture: "document" });
  expect(result).toMatchObject({ passed: false, artifact: { passed: false }, execution: { passed: false }, workerExecutions: { count: null } });
  expect(result.artifact.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "sections", status: "fail", detail: expect.stringContaining("Prossimi passi") }),
    expect.objectContaining({ id: "placeholders", status: "fail", detail: expect.stringContaining("[inserire]") }),
  ]));
});

it.each([
  ["formula-error.xlsx", "formula-errors", /Sales.*B3.*#REF!/],
  ["wrong-total.xlsx", "total", /Sales.*B4.*26.*25/],
])("fails the workbook variant %s with the cell and actual cause", async (variant, id, detail) => {
  reportFile("spreadsheet", variant);
  const result = await buildReport({ cwd, stateDir, fixture: "spreadsheet" });
  expect(result.artifact.checks).toContainEqual(expect.objectContaining({ id, status: "fail", detail: expect.stringMatching(detail) }));
});

it("reads a real folder-bound project rather than expecting an embedded session payload", async () => {
  reportFile("document");
  const historical = JSON.parse(readFileSync(new URL("../src/session/fixtures/session-with-embedded-project-109.json", import.meta.url), "utf8"));
  const initial = normalizeProject(historical.session.project)!;
  const opened = createProject(cwd, {
    ...initial,
    gate: { kind: "none" },
    plan: { ...initial.plan!, rows: [initial.plan!.rows[0]!] },
    milestones: [initial.milestones[0]!],
  }, { stateDir, records: stateDirProjectRecords(stateDir) });
  if (!opened.ok) throw new Error(opened.problem.message);
  const { stored: file, decisionSeq } = opened.opened;
  stored({ projectRef: { folder: file.folder, id: file.id, revision: file.revision, decisionSeq } });
  const result = await buildReport({ cwd, stateDir });
  expect(result.execution.project?.plan?.rows[0]?.taskId).toBe("t1");
  expect(result.artifact.passed).toBe(true);
  expect(result.execution.passed).toBe(false);
  expect(result.blocking.join("\n")).toContain("no verdict");
});

it("keeps uncounted worker runs unknown and blocks a project that still waits", async () => {
  reportFile("document");
  stored({ project: { ...project, gate: { kind: "milestone", id: "m1" } } });
  outcome();
  const result = await buildReport({ cwd, stateDir });
  expect(result).toMatchObject({
    fixture: "document", passed: false, artifact: { passed: true }, execution: { passed: false },
    workerExecutions: { count: null, known: 0, taskRecords: 1, withoutCounts: 1 },
  });
  expect(result.blocking).toEqual(expect.arrayContaining([expect.stringContaining("milestone gate")]));
});

it("does not combine a passing artifact with a different working directory's session", async () => {
  reportFile("spreadsheet");
  stored({ project }, dir);
  outcome({ count: 1 });
  const result = await buildReport({ cwd, stateDir, session: sessionId });
  expect(result).toMatchObject({ passed: false, artifact: { passed: true }, execution: { passed: false }, workerExecutions: { count: null } });
  expect(result.blocking.join("\n")).toMatch(/working director/);
});

it("writes a machine-readable report and returns 1 when the run has no evidence", () => {
  const output = join(dir, "report.json");
  const result = spawnSync(process.execPath, [entry, "--cwd", cwd, "--state-dir", stateDir, "--fixture", "document", "--output", output], {
    encoding: "utf8", timeout: 30_000, windowsHide: true,
  });
  expect(result.status, result.stderr).toBe(1);
  expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ fixture: "document", passed: false, artifact: { passed: false }, execution: { passed: false } });
}, 35_000);

it("validates arguments and requires an explicit fixture when both deliverables exist", async () => {
  expect(parseArgs(["--cwd", "/test", "--fixture", "other"])).toHaveProperty("error");
  expect(parseArgs(["--cwd"])).toHaveProperty("error");
  expect(parseArgs(["--help"])).toEqual({ help: true });
  reportFile("document");
  reportFile("spreadsheet");
  expect(await buildReport({ cwd, stateDir })).toMatchObject({
    fixture: null, passed: false, blocking: expect.arrayContaining([expect.stringContaining("--fixture")]),
  });
});
