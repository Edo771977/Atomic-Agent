/**
 * `project.backlog.add` (issue #111): the director proposes backlog
 * items; workers never see the tool; only the person promotes or drops.
 */
import { describe, expect, it } from "vitest";

import { compressToolResult } from "../../compressor/result-compressor.js";
import { foldProjectUpdate } from "../../agent/step/project-fold.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../../prompt/tool-descriptors.js";
import { listKnownToolResourceClasses } from "../../agent/tool-resource-class.js";
import { applyProjectDecision, applyProjectUpdate, gateVersion, type ProjectState, type ProjectUpdate } from "../../session/session-project.js";
import { createEmptySessionState, type SessionState } from "../../session/session-state.js";
import { roleAdmits } from "../tool-roles.js";
import type { ToolContext } from "../tool-registry.js";
import { PROJECT_BACKLOG_ADD_TOOL, buildProjectBacklogTool, parseProjectBacklogArgs } from "./project-backlog-tool.js";
import { PROJECT_TOOL_NAMES, PROJECT_UPDATE_DETAIL } from "./project-tools.js";
import { withProjectToolVisibility } from "./project-surface.js";
import { isWorkerVisibleTool } from "./worker-tool-policy.js";

const NOW = 1_700_000_000_000;
const ctx = { workingDir: "/tmp/p", sessionId: "s1", stepIndex: 0 } as unknown as ToolContext;

/** A project with an approved brief and plan, milestone m1 running. */
function project(): ProjectState {
  const brief = applyProjectUpdate(undefined, { kind: "brief", brief: { what: "A game", users: "Kids", how: "HTML", successCriteria: ["Runs"] }, draftedAfterUntrusted: false }, NOW);
  if (!brief.ok) throw new Error(brief.error.message);
  const approved = applyProjectDecision(brief.project, { gate: { kind: "brief" }, version: gateVersion(brief.project)!, verdict: "approve" }, { now: NOW });
  if (!approved.ok) throw new Error(approved.error.message);
  const row = { taskId: "t1", title: "Board", milestoneId: "m1", worker: "local:a", reviewer: null, reason: "r", basis: "preset" as const, samples: 0, estCostUsd: 0, estMs: 1 };
  const plan = applyProjectUpdate(approved.project, { kind: "plan", milestones: [{ id: "m1", title: "Base", kind: "base" }], rows: [row], detail: "compact" }, NOW);
  if (!plan.ok) throw new Error(plan.error.message);
  const go = applyProjectDecision(plan.project, { gate: { kind: "plan" }, version: gateVersion(plan.project)!, verdict: "approve" }, { now: NOW });
  if (!go.ok) throw new Error(go.error.message);
  const run = applyProjectUpdate(go.project, { kind: "milestone_run", id: "m1", runId: "run-1" }, NOW);
  if (!run.ok) throw new Error(run.error.message);
  return run.project;
}

describe("project.backlog.add: arguments", () => {
  it("takes a title, source, note, condition and origin; nothing that decides", () => {
    expect(parseProjectBacklogArgs({ title: "Dark mode", source: "director", fromPerson: true, note: "asked during m1", condition: "when themes exist", milestoneId: "m1" })).toEqual({
      ok: true,
      item: { title: "Dark mode", source: "director", fromPerson: true, note: "asked during m1", condition: "when themes exist", origin: { milestoneId: "m1" } },
    });
    for (const bad of [
      { source: "director" },
      { title: "  ", source: "director" },
      { title: "x" },
      { title: "x", source: "martian" },
      // Review: the director cannot label an item as the person's own.
      { title: "x", source: "person" },
      { title: "x", source: "worker", fromPerson: true },
      { title: "x", source: "director", fromPerson: "yes" },
      { title: "x", source: "director", state: "promoted" },
      { title: "x", source: "director", id: "b7" },
      { title: "x", source: "director", origin: { milestoneId: "m1" } },
      { title: "x", source: "director", milestoneId: "" },
      { title: "x", source: "director", taskId: 3 },
      { title: "x", source: "director", note: 3 },
    ]) {
      expect(parseProjectBacklogArgs(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("project.backlog.add: the tool", () => {
  const tool = buildProjectBacklogTool();

  it("is read-only, a project tool, and hands back a backlog_add update with the next id", async () => {
    expect(tool.name).toBe(PROJECT_BACKLOG_ADD_TOOL);
    expect(tool.readonly).toBe(true);
    expect(PROJECT_TOOL_NAMES).toContain(PROJECT_BACKLOG_ADD_TOOL);
    const p = project();
    const result = await tool.run({ title: "Export PDF", source: "director", condition: "when the report page exists" }, { ...ctx, project: p });
    expect(result.status).toBe("ok");
    const update = result.details[PROJECT_UPDATE_DETAIL] as ProjectUpdate;
    // The id is the fold's: two calls of one step never share one.
    expect(update).toEqual({ kind: "backlog_add", item: { title: "Export PDF", source: "director", condition: "when the report page exists" } });
    expect(result.summary).not.toMatch(/\bb1\b/);
    expect(result.summary).toMatch(/proposed/);
    expect(result.summary).toMatch(/only the person/i);
    expect(result.summary).toMatch(/seed/i);
  });

  it("refuses what the project would refuse, with the reason", async () => {
    const none = await tool.run({ title: "x", source: "director" }, ctx);
    expect(none.status).toBe("error");
    expect(none.summary).toMatch(/brief/);
    const noRun = await tool.run({ title: "x", source: "worker" }, { ...ctx, project: project() });
    expect(noRun.status).toBe("error");
    expect(noRun.summary).toMatch(/taskId/);
    const ran = await tool.run({ title: "x", source: "worker", taskId: "t1" }, { ...ctx, project: project() });
    expect(ran.status).toBe("ok");
  });

  it("folds only from its own tool, and a person's item outlives the turn on the session", async () => {
    const session: SessionState = { ...createEmptySessionState({ id: "s", workingDir: "/tmp/p" }), project: project() };
    const result = await tool.run({ title: "Add sound", source: "director", fromPerson: true, milestoneId: "m1" }, { ...ctx, project: session.project });
    const folded = foldProjectUpdate(session, result, NOW + 5);
    expect(folded.result.status).toBe("ok");
    expect(folded.session.project?.backlog).toEqual([{ id: "b1", title: "Add sound", source: "director", fromPerson: true, createdAt: NOW + 5, origin: { milestoneId: "m1" } }]);
    expect(folded.session.project?.gate).toEqual(session.project!.gate);
    expect(folded.session.project?.backlogStates).toBeUndefined();
    // The same update from another tool is ignored.
    const posed = compressToolResult({ tool: "project.brief", status: "ok", output: "x", details: { [PROJECT_UPDATE_DETAIL]: result.details[PROJECT_UPDATE_DETAIL] } });
    expect(foldProjectUpdate(session, posed, NOW).session).toBe(session);
    const mcp = compressToolResult({ tool: "mcp.server.tool", status: "ok", output: "x", details: { [PROJECT_UPDATE_DETAIL]: result.details[PROJECT_UPDATE_DETAIL] } });
    expect(foldProjectUpdate(session, mcp, NOW).session).toBe(session);
  });
});

describe("project.backlog.add: who sees it", () => {
  it("is the orchestrator's, never a worker's or a builder's", () => {
    expect(isWorkerVisibleTool(PROJECT_BACKLOG_ADD_TOOL)).toBe(false);
    expect(roleAdmits("orchestrator", PROJECT_BACKLOG_ADD_TOOL)).toBe(true);
    expect(roleAdmits("builder", PROJECT_BACKLOG_ADD_TOOL)).toBe(false);
  });

  it("hides with the other project tools where no surface draws a gate", () => {
    const filter = withProjectToolVisibility(undefined, false)!;
    expect(filter(PROJECT_BACKLOG_ADD_TOOL)).toBe(false);
  });

  it("is in the catalog: descriptor, args schema and a batchable read class", () => {
    const d = DEFAULT_TOOL_DESCRIPTORS.find((x) => x.name === PROJECT_BACKLOG_ADD_TOOL);
    expect(d).toBeDefined();
    expect(d!.argsJsonSchema).toBeDefined();
    expect(listKnownToolResourceClasses()[PROJECT_BACKLOG_ADD_TOOL]).toBe("pure_read");
  });
});

describe("project.backlog.add: ids in one step (review)", () => {
  it("two calls from the same step's snapshot fold as two items with their own ids", async () => {
    const tool = buildProjectBacklogTool();
    const session: SessionState = { ...createEmptySessionState({ id: "s", workingDir: "/tmp/p" }), project: project() };
    const a = await tool.run({ title: "First", source: "director" }, { ...ctx, project: session.project });
    const b = await tool.run({ title: "Second", source: "director" }, { ...ctx, project: session.project });
    const once = foldProjectUpdate(session, a, NOW);
    const twice = foldProjectUpdate(once.session, b, NOW);
    expect(twice.result.status).toBe("ok");
    expect(twice.session.project?.backlog?.map((x) => `${x.id} ${x.title}`)).toEqual(["b1 First", "b2 Second"]);
  });
});
