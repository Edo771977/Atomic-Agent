import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseTeamMember } from "../../llm/run-mode/fusion-team.js";
import { applyProjectDecision, applyProjectUpdate, gateVersion, normalizeProject, type ProjectState, type ProjectUpdate } from "../../session/session-project.js";
import { gateContentHash } from "../../session/project-decisions.js";
import type { ToolContext } from "../tool-registry.js";
import { evaluatePlanChecks } from "./plan-checks.js";
import { checkPlanReferences } from "./plan-references.js";
import { projectGateView } from "./project-gate-view.js";
import { PROJECT_UPDATE_DETAIL, buildProjectTools, type ProjectPlanContext } from "./project-tools.js";

const worker = parseTeamMember("local:model-a")!;
const context: ProjectPlanContext = {
  workers: [worker], reviewers: [], defaultWorker: worker, reviewerFor: () => null, reviewOn: false, records: [],
  pricing: () => undefined, tokensPerSecond: () => null, isLocal: () => true, minSamples: 2, days: 30, now: 1,
};
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function approvedBrief(): ProjectState {
  const p = applyProjectUpdate(undefined, { kind: "brief", brief: { what: "Game", users: "Kids", how: "Node", successCriteria: ["Runs"] }, draftedAfterUntrusted: false }, 1);
  if (!p.ok) throw new Error(p.error.message);
  const a = applyProjectDecision(p.project, { gate: p.project.gate, version: gateVersion(p.project)!, verdict: "approve" }, { now: 1 });
  if (!a.ok) throw new Error(a.error.message);
  return a.project;
}

async function drafted() {
  const root = mkdtempSync(join(tmpdir(), "plan-refs-gate-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
  const [, plan] = buildProjectTools({
    planContext: () => context,
    outsideContent: () => false,
    planReferences: async (rows, dir, signal) => (await checkPlanReferences(rows, { root: dir, signal, deps: { resolveRgPath: () => null } })).record,
  });
  const project = approvedBrief();
  const args = {
    milestones: [{ id: "m1", title: "Build", kind: "base" }],
    tasks: [
      { id: "t1", title: "Wire src/foo/bar.ts into the game", milestone: "m1", checks: [{ cmd: "npm", args: ["run", "test:xyz"], checks: ["exit 0"] }] },
      { id: "t2", title: "Create src/made.ts", milestone: "m1" },
      { id: "t3", title: "Import src/made.ts", milestone: "m1" },
    ],
  };
  const ctx = { workingDir: root, sessionId: "s1", stepIndex: 0, project, signal: new AbortController().signal } as unknown as ToolContext;
  const result = await plan!.run(args, ctx);
  const update = result.details[PROJECT_UPDATE_DETAIL] as ProjectUpdate;
  const folded = applyProjectUpdate(project, update, 2);
  if (!folded.ok) throw new Error(folded.error.message);
  return { result, project: folded.project };
}

describe("references at the plan gate (issue #120)", () => {
  it("lists a missing file and a missing script with the citing task, and not a file a task creates", async () => {
    const { result, project } = await drafted();
    expect(result.summary).toMatch(/references: warn: Missing: src\/foo\/bar\.ts \(t1: not in the project folder\), npm script test:xyz \(t1: no such script in package\.json\)/);
    expect(result.summary).not.toMatch(/Missing:[^\n]*src\/made\.ts/);
    expect(result.details.planChecks).toContainEqual(expect.objectContaining({ dimension: "references", verdict: "warn", taskIds: ["t1"] }));
    const view = projectGateView({ sessionId: "s1", project, estimate: null, selectable: { workers: [], reviewers: [] } });
    expect(view.hints).toContainEqual(expect.stringMatching(/^references: warn: Missing: src\/foo\/bar\.ts \(t1/));
    expect(project.plan?.checkResults).toEqual(result.details.planChecks);
  });

  it("never blocks: the person approves over it, even when a caller asks to block the dimension", async () => {
    const { project } = await drafted();
    const decision = { gate: project.gate, version: gateVersion(project)!, verdict: "approve" as const };
    expect(applyProjectDecision(project, decision, { now: 3 }).ok).toBe(true);
    expect(applyProjectDecision(project, decision, { now: 3, planChecks: { blockingDimensions: ["references"] } }).ok).toBe(true);
  });

  it("is kept with the record, outside the gate's content, and reads as not re-checked once the tasks change", async () => {
    const { project } = await drafted();
    const reread = normalizeProject(JSON.parse(JSON.stringify(project)));
    expect(reread).toEqual(project);
    const { referenceCheck: _r, ...withoutRecord } = project.plan!;
    expect(gateContentHash({ ...project, plan: withoutRecord }, { kind: "plan" })).toBe(gateContentHash(project, { kind: "plan" }));
    const raw = JSON.parse(JSON.stringify(project));
    raw.plan.rows[0].title = "Wire src/other.ts";
    const edited = normalizeProject(raw)!;
    expect(edited.plan?.checkResults).toContainEqual(expect.objectContaining({ dimension: "references", verdict: "warn", detail: expect.stringMatching(/^Not re-checked/) }));
    raw.plan.referenceCheck = { verdict: "maybe" };
    expect(normalizeProject(raw)?.plan?.referenceCheck).toBeUndefined();
  });

  it("is absent from plans that were never checked", () => {
    const results = evaluatePlanChecks([{ taskId: "t1", title: "Edit src/x.ts", milestoneId: "m1", worker: "w", reviewer: null, reason: "", basis: "preset", samples: 0, estCostUsd: null, estMs: null }], []);
    expect(results.some((r) => r.dimension === "references")).toBe(false);
  });
});
