/**
 * Issue #109: the fusion project's store in the project folder.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { projectGateView } from "../tools/fusion/project-gate-view.js";
import { PLAN_REVIEW_DIMENSIONS, planReviewBasis, planReviewCallsBasis } from "../tools/fusion/plan-review-record.js";
import { readProjectLessons } from "./project-lessons.js";
import { projectLessonReviewSelection } from "./project-lesson-projection.js";
import { stateDirProjectRecords } from "./project-decisions.js";
import {
  commitProject,
  createProject,
  openProject,
  projectFilePath,
  projectStoreDir,
  parseProjectFile,
  readProjectFile,
  type ProjectStoreOptions,
} from "./project-store.js";
import { applyProjectDecision, applyProjectUpdate, currentProjectLessons, currentProjectLessonsBasis, gateVersion, normalizeProject, type AssignmentRow, type ProjectState } from "./session-project.js";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "session-with-embedded-project-109.json"), "utf8")) as {
  session: { project: unknown };
};

let folder: string;
let stateDir: string;
let options: ProjectStoreOptions;

/** The fixture project with its picture inside this test's state dir. */
function project(): ProjectState {
  const p = normalizeProject(fixture.session.project)!;
  return {
    ...p,
    milestones: p.milestones.map((m) => ({
      ...m,
      ...(m.attachments === undefined ? {} : { attachments: m.attachments.map((a) => ({ ...a, path: join(stateDir, "fusion-runs", "run-1", "shots", "t1-1.png") })) }),
    })),
  };
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "aa-project-"));
  stateDir = mkdtempSync(join(tmpdir(), "aa-state-"));
  options = { stateDir, records: stateDirProjectRecords(stateDir, () => 9), now: () => 1_700_000_100_000 };
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

const created = () => {
  const r = createProject(folder, project(), { ...options, id: "proj-1" });
  if (!r.ok) throw new Error(r.problem.message);
  return r.opened;
};

describe("project store (issue #109)", () => {
  it("reopens a saved plan review as stale after a lesson approval", () => {
    const rows: AssignmentRow[] = [{
      taskId: "t1", milestoneId: "m1", title: "Build", worker: "local-llama:default",
      reviewer: null, reason: "preset", basis: "preset", samples: 0, estCostUsd: 0, estMs: 1000,
      checks: [{ criteria: ["c1"], cmd: "node", args: ["test.js"] }],
    }];
    rows.push({ ...rows[0]!, taskId: "t2", title: "Test" });
    const draft = applyProjectUpdate({
      gate: { kind: "none" }, milestones: [],
      brief: { version: 1, status: "approved", what: "Build", users: "Team", how: "Code",
        successCriteria: [{ id: "c1", text: "Works" }], draftedAfterUntrusted: false },
    }, {
      kind: "plan", milestones: [{ id: "m1", title: "Build", kind: "base" }], rows, detail: "compact",
      draftedAfterUntrusted: false,
      planReview: {
        outcome: "reviewed", reviewer: "local-llama:default", round: 1, sentBack: false, costUsd: null,
        basis: planReviewBasis(rows, ["m1"]), callsBasis: planReviewCallsBasis(), lessonsBasis: projectLessonReviewSelection([], true).basis,
        results: PLAN_REVIEW_DIMENSIONS.map((dimension) => ({ dimension, verdict: "pass", detail: "Reviewed", taskIds: [] })),
      },
    }, 1);
    if (!draft.ok) throw new Error(draft.error.message);
    expect(createProject(folder, draft.project, options).ok).toBe(true);
    const openedProject = () => {
      const opened = openProject(folder, options);
      if (!opened.ok) throw new Error(opened.problem.message);
      return opened.opened.project;
    };
    const view = (project = openedProject()) => {
      return projectGateView({ sessionId: "chat", project, estimate: null,
        selectable: { workers: [], reviewers: [] }, planReviewerConfigured: true });
    };
    expect(view().planReview).toMatchObject({ stale: false, autoApprovable: true });

    const dir = join(projectStoreDir(folder), "lessons");
    mkdirSync(dir);
    writeFileSync(join(dir, "storage.md"), "---\nid: storage\ntitle: Storage\nsource: person\ntouches: []\nstatus: active\nalways: true\n---\n## Decided\nKeep storage local\n## Tried and ruled out\n## Watch out\n");
    const saved = options.records.read(folder);
    if (!saved.ok || !saved.record) throw new Error("Need project record");
    const { id, seq, state } = saved.record;
    const lesson = readProjectLessons(folder).lessons[0]!;
    expect(options.records.write(folder, id, seq, state, undefined, { id: lesson.id, call: { state: "approved", hash: lesson.hash } }).ok).toBe(true);
    const decide = (project: ProjectState, status?: "deferred" | "active") => applyProjectDecision(project, {
      gate: project.gate, version: gateVersion(project)!,
      ...(status === undefined ? { verdict: "approve" } : { verdict: "edit", edits: { lessonStatus: { storage: status } } }),
    }, { now: 2 });
    expect(decide(openedProject())).toMatchObject({ ok: false, error: { code: "review-open", message: expect.stringContaining("lesson-coverage") } });
    expect(view().hints).toContainEqual(expect.stringMatching(/stale.*the lessons changed/));
    expect(view().lessonCoverage).toEqual([expect.objectContaining({ id: "storage", citedBy: [], missingFrom: ["t1", "t2"], deferred: false })]);
    const root = openedProject();
    const scope = root[currentProjectLessons]!;
    root[currentProjectLessons] = { ...scope, active: scope.active.map((lesson) => ({ ...lesson, touches: ["."] })) };
    root.plan = { ...root.plan!, rows: root.plan!.rows.map(({ checks: _checks, ...row }) => row) };
    expect(view(root).lessonCoverage?.[0]?.missingFrom).toEqual(["t1", "t2"]);
    const started = openedProject();
    started.milestones = [{ ...started.milestones[0]!, state: "reviewed", runIds: ["run-old"] }];
    expect(view(started).lessonCoverage?.[0]?.missingFrom).toEqual([]);
    const reviewed = openedProject();
    reviewed.plan!.review!.lessonsBasis = reviewed[currentProjectLessonsBasis]!;
    expect(view(reviewed).planReview?.stale).toBe(false);
    const deferred = decide(reviewed, "deferred");
    if (!deferred.ok) throw new Error(deferred.error.message);
    expect(view(deferred.project).planReview?.stale).toBe(true);
    expect(decide(deferred.project).ok).toBe(true);
    const opened = openProject(folder, options);
    if (!opened.ok) throw new Error(opened.problem.message);
    expect(commitProject(folder, opened.opened.stored.id, { revision: opened.opened.stored.revision, decisionSeq: opened.opened.decisionSeq }, deferred.project, options).ok).toBe(true);
    expect(openedProject().lessonDeferred).toEqual({ storage: lesson.hash });
    expect(readFileSync(projectFilePath(folder), "utf8")).not.toContain("lessonDeferred");
    const active = decide(deferred.project, "active");
    if (!active.ok) throw new Error(active.error.message);
    expect(decide(active.project).ok).toBe(false);

  });

  it("checks declared files against current lesson approvals", () => {
    const draft = created();
    const dir = join(projectStoreDir(folder), "lessons");
    mkdirSync(dir);
    const file = join(dir, "storage.md");
    const text = "---\nid: storage\ntitle: Storage\nsource: person\ntouches: [package.json]\nstatus: active\nalways: true\n---\n## Decided\nKeep storage local\n## Tried and ruled out\n## Watch out\n";
    writeFileSync(file, text);
    const open = () => {
      const result = openProject(folder, options);
      if (!result.ok) throw new Error(result.problem.message);
      return result.opened.project;
    };
    const makePlan = (lessons?: string[]) => {
      const project = open();
      const result = applyProjectUpdate({ ...project, gate: { kind: "none" } }, {
        kind: "plan", detail: "compact", milestones: [{ id: "new", title: "Build", kind: "base" }],
        rows: [
          { taskId: "build", milestoneId: "new", title: "Build", worker: "local-llama:default", reviewer: null,
            reason: "preset", basis: "preset", samples: 0, estCostUsd: 0, estMs: 1000, files: ["./package.json"],
            ...(lessons === undefined ? {} : { lessons }) },
          { taskId: "verify", milestoneId: "new", title: "Verify", worker: "local-llama:default", reviewer: null,
            reason: "preset", basis: "preset", samples: 0, estCostUsd: 0, estMs: 1000,
            checks: [{ cmd: "cat", args: ["./package.json"] }], ...(lessons === undefined ? {} : { lessons }) },
        ],
      }, 3);
      if (!result.ok) throw new Error(result.error.message);
      return result.project;
    };
    const coverage = (p: ProjectState) => projectGateView({
      sessionId: "chat", project: p, estimate: null, selectable: { workers: [], reviewers: [] },
    }).hints.filter((hint) => hint.startsWith("lesson-coverage"));
    expect(coverage(makePlan())).toEqual([]);
    const lesson = readProjectLessons(folder).lessons[0]!;
    expect(options.records.write(folder, draft.stored.id, draft.decisionSeq, draft.project, undefined,
      { id: lesson.id, call: { state: "approved", hash: lesson.hash } }).ok).toBe(true);
    expect(coverage(makePlan())).toEqual([expect.stringMatching(/fail.*storage.*build.*verify/)]);
    const restricted = makePlan(["storage"]);
    restricted[currentProjectLessons]!.workerGetsLessons = () => false;
    expect(coverage(restricted)).toContainEqual(expect.stringMatching(/warn.*worker of build.*storage/));
    const undeclared = makePlan(["storage"]);
    delete undeclared.plan!.rows[0]!.files;
    expect(coverage(undeclared)).toContainEqual(expect.stringMatching(/warn.*build.*no declared/));
    expect(coverage(makePlan(["storage"]))).toEqual([expect.stringMatching(/pass/)]);
    const reloaded = normalizeProject(JSON.parse(JSON.stringify(makePlan(["storage"]))))!;
    expect(coverage(reloaded)).toEqual([]);
    writeFileSync(file, text.replace("Keep storage local", "Use SQLite"));
    expect(coverage(makePlan())).toEqual([expect.stringMatching(/warn.*storage.*changed or was removed/)]);
    rmSync(file);
    expect(coverage(makePlan())).toEqual([expect.stringMatching(/warn.*storage.*changed or was removed/)]);
  });

  it("writes content only, with a schema version, and readable views", () => {
    created();
    const raw = JSON.parse(readFileSync(projectFilePath(folder), "utf8")) as Record<string, any>;
    expect(raw.schemaVersion).toBe(2);
    expect(raw.id).toBe("proj-1");
    expect(raw.revision).toBe(1);
    const text = JSON.stringify(raw);
    for (const word of ['"approved"', '"reviewed"', "approvedAt", "reviewOverride", "corrections", "approvedCriteria"]) expect(text).not.toContain(word);
    // Evidence references stay where they are, relative to the state dir.
    expect(raw.project.milestones[0].attachments[0].path).toBe("fusion-runs/run-1/shots/t1-1.png");
    expect(raw.project.milestones[0].criteriaFacts[0].reservation).toBe("only a lint-warned check supports it");
    for (const view of ["BRIEF.md", "PLAN.md", "STATUS.md"]) {
      const body = readFileSync(join(projectStoreDir(folder), view), "utf8");
      expect(body).toMatch(/^<!-- Generated by Atomic Agent from project\.json/);
    }
    expect(readFileSync(join(projectStoreDir(folder), "STATUS.md"), "utf8")).toContain("Waiting on: milestone m2");
    expect(readdirSync(projectStoreDir(folder)).sort()).toEqual(["BRIEF.md", "PLAN.md", "STATUS.md", "project.json"]);
  });

  it("opens to the same project, decisions included", () => {
    created();
    const opened = openProject(folder, options);
    expect(opened.ok && opened.opened.project).toEqual(project());
  });

  it("refuses a second project in the same folder", () => {
    created();
    const again = createProject(folder, project(), options);
    expect(!again.ok && again.problem.code).toBe("exists");
  });

  it("rejects an unknown schema version with a clear message and never overwrites it", () => {
    const c = created();
    const raw = JSON.parse(readFileSync(projectFilePath(folder), "utf8")) as Record<string, unknown>;
    const newer = `${JSON.stringify({ ...raw, schemaVersion: 3 })}\n`;
    writeFileSync(projectFilePath(folder), newer);
    const opened = openProject(folder, options);
    expect(opened.ok).toBe(false);
    if (!opened.ok) {
      expect(opened.problem.code).toBe("unsupported-schema");
      expect(opened.problem.message).toMatch(/schema version 3; this Atomic Agent reads versions 1 and 2\. Update Atomic Agent/);
    }
    const write = commitProject(folder, "proj-1", { revision: 1, decisionSeq: c.decisionSeq }, c.project, options);
    expect(!write.ok && write.problem.code).toBe("unsupported-schema");
    expect(readFileSync(projectFilePath(folder), "utf8")).toBe(newer);
  });

  it.each([
    ["not JSON", "{ nope"],
    ["a milestone gate naming no milestone", JSON.stringify({ schemaVersion: 1, id: "p", name: "x", revision: 1, createdAt: 1, updatedAt: 1, project: { milestones: [], gate: { kind: "milestone", id: "zz" } } })],
    ["no schema version", JSON.stringify({ id: "p", name: "x", revision: 1, createdAt: 1, updatedAt: 1, project: { milestones: [], gate: { kind: "none" } } })],
  ])("reports a damaged file (%s), does not open it and does not overwrite it", (_what, body) => {
    const c = created();
    writeFileSync(projectFilePath(folder), body);
    const opened = openProject(folder, options);
    expect(!opened.ok && opened.problem.code).toBe("damaged");
    expect(!opened.ok && opened.problem.message).toContain("the project was not opened");
    const write = commitProject(folder, "proj-1", { revision: 1, decisionSeq: c.decisionSeq }, c.project, options);
    expect(write.ok).toBe(false);
    expect(readFileSync(projectFilePath(folder), "utf8")).toBe(body);
  });

  it("keeps unknown top-level fields across a write", () => {
    const c = created();
    const raw = JSON.parse(readFileSync(projectFilePath(folder), "utf8")) as Record<string, unknown>;
    writeFileSync(projectFilePath(folder), JSON.stringify({ ...raw, laterFeature: { a: 1 } }));
    const edited: ProjectState = { ...c.project, brief: { ...c.project.brief!, how: "Web canvas, no server" } };
    const write = commitProject(folder, "proj-1", { revision: 1, decisionSeq: c.decisionSeq }, edited, options);
    expect(write.ok).toBe(true);
    const after = JSON.parse(readFileSync(projectFilePath(folder), "utf8")) as Record<string, unknown>;
    expect(after.laterFeature).toEqual({ a: 1 });
    expect(after.revision).toBe(2);
    expect(readdirSync(projectStoreDir(folder)).some((f) => f.endsWith(".tmp") || f.endsWith(".lock"))).toBe(false);
  });

  it("a write built on an old revision is a conflict", () => {
    const c = created();
    const edited: ProjectState = { ...c.project, brief: { ...c.project.brief!, how: "Changed" } };
    expect(commitProject(folder, "proj-1", { revision: 1, decisionSeq: c.decisionSeq }, edited, options).ok).toBe(true);
    const late = commitProject(folder, "proj-1", { revision: 1, decisionSeq: c.decisionSeq }, { ...edited, brief: { ...edited.brief!, how: "Other" } }, options);
    expect(!late.ok && late.problem.code).toBe("conflict");
  });

  it("two chats approving the same gate: the second gets \"gate already decided\"", () => {
    const c = created();
    const decision = { gate: c.project.gate, version: gateVersion(c.project)!, verdict: "approve" as const };
    const decide = () => {
      const r = applyProjectDecision(c.project, decision, { now: 2 });
      if (!r.ok) throw new Error(r.error.message);
      return commitProject(folder, "proj-1", { revision: c.stored.revision, decisionSeq: c.decisionSeq }, r.project, { ...options, decision, decidedOn: c.project });
    };
    const first = decide();
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.opened.project.milestones[1]?.state).toBe("reviewed");
    const second = decide();
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.problem.code).toBe("already-decided");
      expect(second.problem.message).toMatch(/already decided/);
    }
  });

  it("deleting the chat changes nothing: a new reader finds the project in the folder", () => {
    created();
    const read = readProjectFile(folder, options);
    expect(read.ok && read.stored.project.milestones.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(existsSync(join(projectStoreDir(folder), "BRIEF.md"))).toBe(true);
  });
});

describe("attachment paths stay inside the state dir's fusion runs (issue #109 review)", () => {
  it("the file's mirror and the record drop a picture outside <stateDir>/fusion-runs", async () => {
    const { stateDirProjectRecords } = await import("./project-decisions.js");
    created();
    const raw = JSON.parse(readFileSync(projectFilePath(folder), "utf8")) as Record<string, any>;
    raw.project.milestones[0].attachments = [
      { path: "../../escape.png", caption: "up" },
      { path: join(tmpdir(), "elsewhere.png"), caption: "absolute" },
      { path: "fusion-runs/run-1/shots/t1-1.png", caption: "kept" },
    ];
    const read = parseProjectFile(raw, folder, stateDir);
    expect(read.ok && read.stored.project.milestones[0]?.attachments?.map((a) => a.caption)).toEqual(["kept"]);

    const records = stateDirProjectRecords(stateDir);
    const opened = openProject(folder, options);
    if (!opened.ok) throw new Error(opened.problem.message);
    const p = opened.opened.project;
    const outside = { ...p, milestones: p.milestones.map((m, i) => (i === 0 ? { ...m, attachments: [{ path: join(stateDir, "..", "x.png"), caption: "outside" }, ...(m.attachments ?? [])] } : m)) };
    expect(records.write(folder, "proj-1", opened.opened.decisionSeq, outside).ok).toBe(true);
    const back = records.read(folder);
    expect(back.ok && back.record?.state.milestones[0]?.attachments?.map((a) => a.caption)).toEqual(["The board"]);
  });
});

