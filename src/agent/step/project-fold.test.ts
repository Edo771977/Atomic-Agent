import { describe, expect, it } from "vitest";

import { compressToolResult } from "../../compressor/result-compressor.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { ProjectUpdate } from "../../session/session-project.js";
import { foldProjectUpdate } from "./project-fold.js";

const NOW = 1_700_000_000_000;

const result = (tool: string, update: unknown, status: "ok" | "error" = "ok") =>
  compressToolResult({ tool, status, output: "drafted", details: { projectUpdate: update } });

const brief: ProjectUpdate = {
  kind: "brief",
  brief: { what: "A game", users: "Kids", how: "HTML", successCriteria: ["Runs"] },
  draftedAfterUntrusted: true,
};

describe("foldProjectUpdate (issue #39)", () => {
  const session = createEmptySessionState({ id: "s", workingDir: "/tmp" });

  it("folds an accepted update into SessionState.project", () => {
    const folded = foldProjectUpdate(session, result("project.brief", brief), NOW);
    expect(folded.result.status).toBe("ok");
    expect(folded.session.project).toMatchObject({ gate: { kind: "brief" }, brief: { version: 1, status: "draft", draftedAfterUntrusted: true } });
  });

  it("turns a refusal into the call's error and leaves the project alone", () => {
    const plan: ProjectUpdate = { kind: "plan", milestones: [{ id: "m1", title: "Base", kind: "base" }], rows: [], detail: "compact" };
    const withBrief = foldProjectUpdate(session, result("project.brief", brief), NOW).session;
    const folded = foldProjectUpdate(withBrief, result("project.plan", plan), NOW);
    expect(folded.result.status).toBe("error");
    expect(folded.result.summary).toMatch(/brief is not approved/);
    expect(folded.result.details).toMatchObject({ projectRefused: "brief-not-approved" });
    expect(folded.result.details.projectUpdate).toBeUndefined();
    expect(folded.session).toBe(withBrief);
  });

  it("ignores errored calls, results without an update and malformed details", () => {
    expect(foldProjectUpdate(session, result("project.brief", brief, "error"), NOW).session).toBe(session);
    const plain = compressToolResult({ tool: "os.fs.read", status: "ok", output: "x", details: {} });
    expect(foldProjectUpdate(session, plain, NOW)).toEqual({ session, result: plain });
    const bad = foldProjectUpdate(session, result("project.brief", "nope"), NOW);
    expect(bad.session).toBe(session);
    expect(bad.result.status).toBe("error");
  });

  it("takes an update only from the tool that owns its kind", () => {
    // Any other tool's details.projectUpdate is ignored: the project moves only through its own tools.
    for (const tool of ["os.fs.read", "mcp.server.tool", "fusion.delegate", "project.plan"]) {
      const folded = foldProjectUpdate(session, result(tool, brief), NOW);
      expect(folded.session, tool).toBe(session);
      expect(folded.result.status, tool).toBe("ok");
    }
    // A project tool cannot pose as the dispatch's run record either.
    const run = foldProjectUpdate(session, result("project.milestone", { kind: "milestone_run", id: "m1", runId: "r" }), NOW);
    expect(run.session).toBe(session);
    expect(foldProjectUpdate(session, result("project.brief", brief), NOW).session.project).toBeDefined();
  });

  it("folds a milestone_run from a failed fan-out (work started), keeping the call's own error", () => {
    let project = foldProjectUpdate(session, result("project.brief", brief), NOW).session;
    project = { ...project, project: { ...project.project!, brief: { ...project.project!.brief!, status: "approved" }, gate: { kind: "none" },
      plan: { rows: [], totals: { costUsd: null, ms: null, unknownCostRows: 0 }, detail: "compact", status: "approved", version: 1, draftedAfterUntrusted: false },
      milestones: [{ id: "m1", title: "Base", kind: "base", state: "approved", runIds: [], updatedAt: NOW }] } };
    const failed = result("fusion.delegate", { kind: "milestone_run", id: "m1", runId: "run-1" }, "error");
    const folded = foldProjectUpdate(project, failed, NOW);
    expect(folded.result).toBe(failed);
    expect(folded.session.project?.milestones[0]).toMatchObject({ state: "in_progress", runIds: ["run-1"] });
    // A successful fan-out whose run update is refused stays a success, with a note.
    const okRun = result("fusion.delegate", { kind: "milestone_run", id: "nope", runId: "run-3" });
    const kept = foldProjectUpdate(project, okRun, NOW);
    expect(kept.session).toBe(project);
    expect(kept.result.status).toBe("ok");
    expect(kept.result.summary).toContain("drafted");
    expect(kept.result.summary).toMatch(/milestone was not updated/);
    expect(kept.result.details).toMatchObject({ projectRefused: "unknown-milestone" });
    expect(kept.result.details.projectUpdate).toBeUndefined();
    // A refused run update on a failed call leaves both alone.
    const unknown = result("fusion.delegate", { kind: "milestone_run", id: "nope", runId: "run-2" }, "error");
    expect(foldProjectUpdate(project, unknown, NOW)).toEqual({ session: project, result: unknown });
  });
});
