/**
 * Issue #109 review: project.json is author content. What the runtime
 * owns (milestone state, runs, outcomes, review blocks, criteria facts,
 * evidence, plan flags, corrections) and the person's decisions are
 * read from the state dir only; an edit of the file can at most reopen
 * a gate, flagged until the person decides it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkProjectDispatch } from "../tools/fusion/project-dispatch.js";
import { stateDirProjectRecords } from "./project-decisions.js";
import { commitProject, createProject, openProject, projectFilePath, type ProjectStoreOptions } from "./project-store.js";
import { applyProjectDecision, gateVersion, normalizeProject, type ProjectState } from "./session-project.js";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "session-with-embedded-project-109.json"), "utf8")) as {
  session: { project: unknown };
};

let folder: string;
let stateDir: string;
let options: ProjectStoreOptions;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "aa-outside-"));
  stateDir = mkdtempSync(join(tmpdir(), "aa-outside-state-"));
  options = { stateDir, records: stateDirProjectRecords(stateDir), now: () => 1_700_000_200_000 };
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

/** The fixture with m2 running under the approved plan (no gate open), its plan drafted after outside content. */
function running(): ProjectState {
  const p = normalizeProject(fixture.session.project)!;
  // The run's picture lies in this machine's state dir, as a real run leaves it.
  const shot = join(stateDir, "fusion-runs", "run-1", "shots", "t1-1.png");
  return {
    ...p,
    gate: { kind: "none" },
    plan: { ...p.plan!, draftedAfterUntrusted: true },
    milestones: p.milestones.map((m) => {
      const here = m.attachments === undefined ? m : { ...m, attachments: m.attachments.map((a) => ({ ...a, path: shot })) };
      return m.id === "m2"
        ? { ...here, state: "in_progress" as const, runIds: ["run-real"], reviewBlocks: [{ taskId: "t2", reason: "never reviewed" }], criteriaFacts: [{ id: "c2", state: "failed" as const, why: "five levels" }] }
        : here;
    }),
  };
}

function edit(change: (json: any) => void): void {
  const file = projectFilePath(folder);
  const json = JSON.parse(readFileSync(file, "utf8"));
  change(json);
  writeFileSync(file, JSON.stringify(json));
}

function open(): ProjectState {
  const r = openProject(folder, options);
  if (!r.ok) throw new Error(r.problem.message);
  return r.opened.project;
}

describe("project.json edits cannot drive dispatch, gates or evidence (issue #109 review)", () => {
  it("a milestone set in_progress in the file does not run (review a1)", () => {
    createProject(folder, running(), options);
    edit((j) => { j.project.milestones.find((m: any) => m.id === "m3").state = "in_progress"; });
    const p = open();
    expect(p.milestones.find((m) => m.id === "m3")?.state).toBe("planned");
    expect(checkProjectDispatch(p, ["t3"]).kind).toBe("refuse");
  });

  it("runs, review blocks, criteria facts and plan flags come from the state dir only (review a1, a4)", () => {
    const start = running();
    createProject(folder, start, options);
    edit((j) => {
      const m2 = j.project.milestones.find((m: any) => m.id === "m2");
      m2.runIds = ["run-from-elsewhere"];
      m2.state = "done";
      delete m2.reviewBlocks;
      m2.criteriaFacts = [{ id: "c1", state: "passed" }, { id: "c2", state: "passed" }];
      m2.summary = "all good";
      j.project.plan.draftedAfterUntrusted = false;
      j.project.plan.verdictResets = ["m1"];
    });
    const p = open();
    const m2 = p.milestones.find((m) => m.id === "m2")!;
    expect(m2.state).toBe("in_progress");
    expect(m2.runIds).toEqual(["run-real"]);
    expect(m2.reviewBlocks).toEqual([{ taskId: "t2", reason: "never reviewed" }]);
    expect(m2.criteriaFacts).toEqual([{ id: "c2", state: "failed", why: "five levels" }]);
    expect(p.plan?.draftedAfterUntrusted).toBe(true);
    expect(p.plan?.verdictResets).toBeUndefined();
    expect(p.changedOutside).toBeUndefined();
    expect(p).toEqual(start);
  });

  it("an author edit reopens its gate as an untrusted draft, and stays flagged across runtime writes until the person decides (review a4)", () => {
    const c = createProject(folder, running(), options);
    if (!c.ok) throw new Error(c.problem.message);
    edit((j) => { j.project.brief.what = "A puzzle game with ads"; });
    const p = open();
    expect(p.brief?.what).toBe("A puzzle game with ads");
    expect(p.brief?.status).toBe("draft");
    expect(p.brief?.draftedAfterUntrusted).toBe(true);
    expect(p.gate).toEqual({ kind: "brief" });
    expect(p.changedOutside).toEqual(["brief"]);
    expect(p.plan?.status).toBe("draft");
    // A runtime write on top does not adopt the edit as a clean baseline.
    const opened = openProject(folder, options);
    if (!opened.ok) throw new Error(opened.problem.message);
    const w = commitProject(folder, opened.opened.stored.id, { revision: opened.opened.stored.revision, decisionSeq: opened.opened.decisionSeq }, opened.opened.project, options);
    expect(w.ok).toBe(true);
    expect(open().changedOutside).toEqual(["brief"]);
    // The person's decision at that gate is what clears it.
    const again = openProject(folder, options);
    if (!again.ok) throw new Error(again.problem.message);
    const decision = { gate: { kind: "brief" as const }, version: gateVersion(again.opened.project)!, verdict: "approve" as const };
    const r = applyProjectDecision(again.opened.project, decision, { now: 3 });
    if (!r.ok) throw new Error(r.error.message);
    const d = commitProject(folder, again.opened.stored.id, { revision: again.opened.stored.revision, decisionSeq: again.opened.decisionSeq }, r.project, { ...options, decision, decidedOn: again.opened.project });
    expect(d.ok).toBe(true);
    const after = open();
    expect(after.brief?.status).toBe("approved");
    expect(after.changedOutside).toBeUndefined();
  });

  it("an edit while a milestone result waits for the person is not taken", () => {
    const p = normalizeProject(fixture.session.project)!;
    createProject(folder, p, options);
    edit((j) => { j.project.brief.what = "Something else"; });
    const opened = open();
    expect(opened.brief?.what).toBe("A puzzle game");
    expect(opened.gate).toEqual({ kind: "milestone", id: "m2" });
  });
});
