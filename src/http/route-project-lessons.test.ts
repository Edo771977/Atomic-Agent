import assert from "node:assert/strict";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AGENT_TOOL_CHILD_ENV } from "../sandbox/command-env.js";
import * as lessons from "../session/project-lessons.js";
import { fixtureProjectGateView } from "../session/project-gate-view-fixtures.js";
import { projectRecordsDir, stateDirProjectRecords } from "../session/project-decisions.js";
import { projectLessonPanel, type ProjectLessonPanel } from "../session/project-lesson-operations.js";
import { createEmptySessionState } from "../session/session-state.js";
import { startTestHarness, type Harness } from "./test-harness.js";

const key = "lesson-test-api-key";
let h: Harness;
let file: string;
let session: ReturnType<typeof createEmptySessionState>;
const write = (status = "active", text = "Keep storage local.") => writeFileSync(file, [
  "---", "id: storage", "title: Local storage", "source: person", "touches: [src/storage]", "always: true", "status: " + status,
  "---", "## Decided", text, "## Tried and ruled out", "Remote database", "## Watch out", "Test migrations",
].join("\n"));

async function setup(apiKey: string | null = key) {
  h = await startTestHarness({ apiKey });
  const folder = join(h.stateDir, "project");
  const directory = join(folder, ".atomic", "project", "lessons");
  mkdirSync(directory, { recursive: true });
  file = join(directory, "storage.md");
  write();
  expect(stateDirProjectRecords(h.stateDir).write(folder, "project", 0, { milestones: [], gate: { kind: "none" } }).ok).toBe(true);
  session = createEmptySessionState({ id: "s1", workingDir: folder });
  session.projectRef = { folder, id: "project", revision: 1, decisionSeq: 0 };
  vi.spyOn(h.runtime.sessionStore, "load").mockImplementation(id => id === session.id ? session : null);
}

beforeEach(() => setup());
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await h.cleanup(); });

type LessonResponse = {
  panel: Omit<ProjectLessonPanel, "rows"> & { rows: Array<ProjectLessonPanel["rows"][number] & { promptEnds: { decided: { standard: number } } }> };
  error: { code: string };
};
const read = async (res: Response): Promise<LessonResponse> => await res.json() as LessonResponse;

const list = (token: string | null = key) => fetch(h.baseUrl + "/api/project/lessons?session=s1", { headers: token ? { authorization: "Bearer " + token } : {} });
const decide = (action: string, fingerprint: string, orphaned = false, token: string | null = key) => fetch(h.baseUrl + "/api/project/lessons", {
  method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
  body: JSON.stringify({ session: "s1", lesson: "storage", action, fingerprint, ...(orphaned ? { orphaned } : {}) }),
});

it("lists and records a decision against the current fingerprint, and can reopen an orphan", async () => {
  const first = await list();
  expect(first.status).toBe(200);
  const { panel: { rows: [row] } } = await read(first);
  assert.ok(row && "status" in row);
  expect(row.status.effectiveStatus).toBe("unapproved");
  expect(row.promptEnds.decided.standard).toBe("Keep storage local.".length);
  write("active", "Review migrations locally.");
  const stale = await decide("approve", row.hash);
  expect(stale.status).toBe(409);
  const changed = await read(stale);
  expect(changed.error.code).toBe("stale-view");
  const current = changed.panel.rows[0];
  assert.ok(current);
  const { hash } = current;
  const approval = await decide("approve", hash);
  expect(approval.status).toBe(200);
  expect((await read(approval)).panel.rows[0]).toMatchObject({ status: { approvedByPerson: true } });
  unlinkSync(file);
  expect((await decide("retire", hash)).status).toBe(409);
  expect((await read(await list())).panel.rows[0]).toMatchObject({ orphanedChoice: "approved" });
  expect((await decide("reopen", hash, true)).status).toBe(200);
  expect((await read(await list())).panel.rows).toEqual([]);
});

it("rejects malformed, proposed, running, and incognito decisions", async () => {
  expect((await decide("approve", "bad")).status).toBe(400);
  write("proposed");
  const { panel: { rows: [row] } } = await read(await list());
  assert.ok(row);
  expect((await decide("approve", row.hash)).status).toBe(400);
  const live = vi.spyOn(h.runtime.sessionStore, "liveProjectTurn").mockReturnValue("s2");
  expect((await decide("retire", row.hash)).status).toBe(409);
  live.mockReturnValue(null);
  session.incognito = { since: 1, owner: "test" };
  expect((await list()).status).toBe(409);
  expect((await decide("retire", row.hash)).status).toBe(409);
});

it("requires configured authentication for POST while allowing GET without a key", async () => {
  await h.cleanup();
  await setup(null);
  const listing = await list(null);
  expect(listing.status).toBe(200);
  const row = (await read(listing)).panel.rows[0];
  assert.ok(row);
  const denied = await decide("approve", row.hash, false, null);
  expect(denied.status).toBe(403);
  expect((await read(denied)).error.code).toBe("person-auth-required");
  expect((await read(await list(null))).panel.rows[0]).toMatchObject({ status: { approvedByPerson: false } });
});

it("accepts a valid bearer key and ignores the server process marker for HTTP", async () => {
  vi.stubEnv(AGENT_TOOL_CHILD_ENV, "1");
  const listing = await list();
  expect(listing.status).toBe(200);
  const row = (await read(listing)).panel.rows[0];
  assert.ok(row);
  expect((await decide("approve", row.hash, false, null)).status).toBe(401);
  expect((await decide("approve", row.hash)).status).toBe(200);
});

it.each(["folder mismatch", "failed project load"])("refuses a bound project after %s", async (reason) => {
  const row = (await read(await list())).panel.rows[0];
  assert.ok(row);
  if (reason === "folder mismatch") session.workingDir = h.stateDir;
  else session.projectProblem = "Could not load " + h.stateDir;
  for (const response of [await list(), await decide("approve", row.hash)]) {
    expect(response.status).toBe(404);
    const body = await read(response);
    expect(body.error.code).toBe("no-project");
    expect(body.panel.rows).toEqual([]);
  }
});

it("rereads the current lesson choices after a record sequence conflict", async () => {
  const row = (await read(await list())).panel.rows[0];
  assert.ok(row);
  vi.spyOn(lessons, "writeProjectLessonDecision").mockImplementationOnce((records, record) => {
    expect(records.write(record.folder, record.id, record.seq, record.state, undefined,
      { id: row.id, call: { hash: row.hash, state: "retired" } }).ok).toBe(true);
    return { ok: false, problem: { code: "conflict", message: "stale record" } };
  });
  const response = await decide("approve", row.hash);
  expect(response.status).toBe(409);
  const body = await read(response);
  expect(body.error.code).toBe("stale-view");
  expect(body.panel.rows[0]).toMatchObject({ status: { effectiveStatus: "retired" } });
  expect(body).not.toHaveProperty("session_id");
});

it.each([["locked", 503, "busy"], ["io", 500, "io"]] as const)("reports record write %s separately", async (problem, status, code) => {
  const row = (await read(await list())).panel.rows[0];
  assert.ok(row);
  vi.spyOn(lessons, "writeProjectLessonDecision").mockReturnValueOnce({
    ok: false, problem: { code: problem, message: h.stateDir },
  });
  const response = await decide("approve", row.hash);
  expect(response.status).toBe(status);
  expect((await read(response)).error.code).toBe(code);
});

it("uses the same browser-friendly running-turn message in the panel and error", async () => {
  const row = (await read(await list())).panel.rows[0];
  assert.ok(row);
  vi.spyOn(h.runtime.sessionStore, "liveProjectTurn").mockReturnValue("s2");
  const response = await decide("retire", row.hash);
  expect(response.status).toBe(409);
  const body = await read(response);
  expect(body.error).toMatchObject({ code: "turn-running", message: "Wait for the turn to finish." });
  expect(body.panel.blocked).toBe("Wait for the turn to finish.");
});

it("publishes the updated gate and its lesson coverage only after a successful choice", async () => {
  const row = (await read(await list())).panel.rows[0];
  assert.ok(row);
  const coverage = [{ id: "storage", title: "Local storage", citedBy: [], missingFrom: ["t1"], deferred: false }];
  const view = fixtureProjectGateView({ kind: "plan" }, { lessonCoverage: coverage });
  vi.spyOn(h.runtime, "projectState").mockReturnValue(view);
  const observer = vi.fn();
  const off = h.handle.projectGateBus.subscribe(observer);
  try {
    expect((await decide("approve", "0".repeat(64))).status).toBe(409);
    expect(observer).not.toHaveBeenCalled();
    const choice = await decide("approve", row.hash);
    expect(choice.status).toBe(200);
    expect(await choice.json()).toMatchObject({ view: { lessonCoverage: coverage } });
    expect(observer).toHaveBeenCalledExactlyOnceWith({ type: "project_gate", sessionId: session.id, view });
  } finally {
    off();
  }
});

it("keeps local record paths out of damaged-record error messages", async () => {
  const records = stateDirProjectRecords(h.stateDir);
  const record = records.read(session.workingDir);
  assert.ok(record.ok && record.record);
  const directory = projectRecordsDir(h.stateDir);
  const recordFile = readdirSync(directory).find(name => name.endsWith(".json"));
  assert.ok(recordFile);
  const recordPath = join(directory, recordFile);
  writeFileSync(recordPath, "broken");
  const local = projectLessonPanel(session, h.stateDir, () => false);
  expect(local.panel.blocked).toContain(recordPath);
  const response = await list();
  expect(response.status).toBe(404);
  const body = await read(response);
  expect(body.error).toMatchObject({ code: "no-project", message: "This chat's project record is unavailable." });
  expect(body.panel.blocked).toBe("This chat's project record is unavailable.");
  expect(JSON.stringify(body)).not.toContain(h.stateDir);
});

it("renders invisible characters in skipped-file names and reasons as printable escapes", async () => {
  const path = join(session.workingDir, ".atomic", "project", "lessons", "invisible\u202E.md");
  writeFileSync(path, "Invisible \u202E text");
  const response = await list();
  const body = await read(response);
  expect(body.panel.problems[0]?.file).toContain("\\u{202E}");
  expect(JSON.stringify(body.panel.problems)).not.toContain("\u202E");
});
