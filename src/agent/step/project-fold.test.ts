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
});
