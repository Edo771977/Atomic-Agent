import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stateDirProjectRecords } from "../session/project-decisions.js";
import type { ProjectLessonPanel } from "../session/project-lesson-operations.js";
import { createEmptySessionState } from "../session/session-state.js";
import { startTestHarness, type Harness } from "./test-harness.js";

let h: Harness;
let file: string;
let session: ReturnType<typeof createEmptySessionState>;
const write = (status = "active", text = "Keep storage local.") => writeFileSync(file, [
  "---", "id: storage", "title: Local storage", "source: person", "touches: [src/storage]", "always: true", "status: " + status,
  "---", "## Decided", text, "## Tried and ruled out", "Remote database", "## Watch out", "Test migrations",
].join("\n"));

beforeEach(async () => {
  h = await startTestHarness();
  const folder = join(h.stateDir, "project");
  const directory = join(folder, ".atomic", "project", "lessons");
  mkdirSync(directory, { recursive: true });
  file = join(directory, "storage.md");
  write();
  expect(stateDirProjectRecords(h.stateDir).write(folder, "project", 0, { milestones: [], gate: { kind: "none" } }).ok).toBe(true);
  session = createEmptySessionState({ id: "s1", workingDir: folder });
  session.projectRef = { folder, id: "project", revision: 1, decisionSeq: 0 };
  vi.spyOn(h.runtime.sessionStore, "load").mockImplementation(id => id === session.id ? session : null);
});

afterEach(async () => { await h.cleanup(); });

type LessonResponse = {
  panel: Omit<ProjectLessonPanel, "rows"> & { rows: Array<ProjectLessonPanel["rows"][number] & { promptEnds: { decided: { standard: number } } }> };
  error: { code: string };
};
const read = async (res: Response): Promise<LessonResponse> => await res.json() as LessonResponse;

const list = () => fetch(h.baseUrl + "/api/project/lessons?session=s1");
const decide = (action: string, fingerprint: string, orphaned = false) => fetch(h.baseUrl + "/api/project/lessons", {
  method: "POST", headers: { "content-type": "application/json" },
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
