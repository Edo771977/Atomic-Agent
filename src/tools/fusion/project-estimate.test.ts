import { describe, expect, it } from "vitest";

import type { TeamMember } from "../../llm/run-mode/fusion-team.js";
import type { ModelTier } from "../../llm/provider/presets/model-tiers.js";
import type { AssignmentRow } from "../../session/session-project.js";
import type { TaskOutcomeRecord } from "./outcome-log.js";
import {
  PRESET_TASK_TOKENS,
  acceptanceRate,
  cheaperVariant,
  describeViolation,
  estimatePlan,
  estimateRow,
  planDetailFor,
  qualityVariant,
  type RowEstimate,
  type VariantContext,
} from "./project-estimate.js";

const NOW = Date.parse("2026-11-01T00:00:00Z");
const DAY = 86_400_000;

const member = (ref: string): TeamMember => {
  const i = ref.indexOf(":");
  return { providerId: ref.slice(0, i), model: ref.slice(i + 1), ref };
};

function rec(over: Partial<TaskOutcomeRecord> = {}): TaskOutcomeRecord {
  return {
    v: 1,
    type: "task",
    ts: new Date(NOW - DAY).toISOString(),
    session: "abc",
    provider: "cloud",
    model: "model-a",
    leg: "cloud",
    role: null,
    taskRole: null,
    status: "ok",
    failure: null,
    attempt: 1,
    judgeRetried: false,
    selfCheckNotice: false,
    escalations: 0,
    judge: "off",
    syntaxDemoted: false,
    steps: 3,
    durationMs: 1000,
    tokensIn: 10,
    tokensOut: 10,
    cachedTokens: null,
    costUsd: 0.1,
    merge: null,
    ...over,
  };
}

const opts = { minSamples: 3, days: 30, now: NOW };

describe("estimateRow", () => {
  it("uses medians of exact member+role rows once there are enough", () => {
    const records = [rec({ costUsd: 0.1, durationMs: 100 }), rec({ costUsd: 0.3, durationMs: 300 }), rec({ costUsd: 0.2, durationMs: 200 })];
    expect(estimateRow(member("cloud:model-a"), null, records, undefined, opts)).toEqual({
      basis: "measured",
      samples: 3,
      estCostUsd: 0.2,
      estMs: 200,
      priceOnly: false,
      reason: "measured: median of 3 runs",
    });
  });

  it("leaves cost unknown when any measured row is unpriced", () => {
    const records = [rec(), rec(), rec({ costUsd: null })];
    expect(estimateRow(member("cloud:model-a"), null, records, undefined, opts)).toMatchObject({ basis: "measured", estCostUsd: null, estMs: 1000 });
  });

  it("ignores rows of another model, role, an old date, or a path-like label", () => {
    const records = [
      rec({ model: "model-b" }),
      rec({ taskRole: "review" }),
      rec({ ts: new Date(NOW - 40 * DAY).toISOString() }),
      rec(),
      rec(),
    ];
    const est = estimateRow(member("cloud:model-a"), null, records, undefined, opts);
    expect(est).toMatchObject({ basis: "preset", samples: 2, reason: "insufficient data, chosen from the preset" });
    const pathLike = estimateRow(member("local:/models/x.gguf"), null, [rec({ provider: "local", model: "/models/x.gguf" })], undefined, { ...opts, minSamples: 1 });
    expect(pathLike.basis).toBe("preset");
  });

  it("matches a legacy row without taskRole by its role", () => {
    const legacy = { ...rec(), role: "review" } as TaskOutcomeRecord;
    delete (legacy as Partial<TaskOutcomeRecord>).taskRole;
    expect(estimateRow(member("cloud:model-a"), "review", [legacy, legacy, legacy], undefined, opts).basis).toBe("measured");
  });

  it("falls back to price × the role's token constant, marked price-only", () => {
    const pricing = { input: 1, output: 10 };
    const est = estimateRow(member("cloud:model-a"), "review", [], pricing, opts);
    const t = PRESET_TASK_TOKENS.review;
    expect(est).toMatchObject({ basis: "preset", samples: 0, priceOnly: true, estMs: null });
    expect(est.estCostUsd).toBeCloseTo((t.input * 1 + t.output * 10) / 1e6, 9);
  });

  it("without a price and speed, cost and time are unknown; with a local speed, time comes from it", () => {
    expect(estimateRow(member("cloud:model-a"), null, [], undefined, opts)).toMatchObject({ estCostUsd: null, estMs: null, priceOnly: false });
    const local = estimateRow(member("local:m"), null, [], undefined, { ...opts, tokensPerSecond: 50 });
    expect(local.estMs).toBe(Math.round((PRESET_TASK_TOKENS.build.output / 50) * 1000));
  });
});

describe("acceptanceRate", () => {
  it("is passed checks over checked rows; null without any", () => {
    const pass = rec({ acceptance: "checks-passed", acceptanceScope: "task-checks" });
    const fail = rec({ acceptance: "checks-failed", acceptanceScope: "task-checks", status: "failed", failure: "checks" });
    expect(acceptanceRate([pass, pass, pass, fail], member("cloud:model-a"), { days: 30, now: NOW })).toBe(0.75);
    expect(acceptanceRate([rec()], member("cloud:model-a"), { days: 30, now: NOW })).toBeNull();
  });
});

function row(taskId: string, milestoneId: string, over: Partial<AssignmentRow> = {}): AssignmentRow {
  return {
    taskId,
    title: taskId,
    milestoneId,
    worker: "cloud:model-a",
    reviewer: null,
    reason: "r",
    basis: "preset",
    samples: 0,
    estCostUsd: 1,
    estMs: 1000,
    ...over,
  };
}

describe("estimatePlan", () => {
  const isLocal = (ref: string) => ref.startsWith("local:");

  it("totals cost and wave time; local tasks share the slots", () => {
    const rows = [
      row("a", "m1", { worker: "local:x", estCostUsd: null, estMs: 1000 }),
      row("b", "m1", { worker: "local:x", estCostUsd: null, estMs: 1000 }),
      row("c", "m1", { worker: "local:x", estCostUsd: null, estMs: 1000 }),
      row("d", "m1", { estCostUsd: 0.5, estMs: 1500 }),
      row("e", "m2", { estCostUsd: 0.25, estMs: 500 }),
    ];
    const est = estimatePlan(rows, { isLocal, localSlots: 2 });
    // m1: local 3×1000 over 2 slots = 2000 > cloud 1500; m2: 500.
    expect(est.totals).toEqual({ costUsd: 0.75, ms: 2500, unknownCostRows: 3 });
    expect(est.milestones).toEqual([
      { id: "m1", costUsd: 0.5, ms: 2000 },
      { id: "m2", costUsd: 0.25, ms: 500 },
    ]);
    expect(est.violations).toEqual([{ kind: "local-slots", severity: "warn", milestoneId: "m1", localTasks: 3, slots: 2 }]);
    expect(est.hardViolations).toEqual([]);
  });

  it("flags a milestone over the turn budget and a plan over the remaining daily limit as hard", () => {
    const rows = [row("a", "m1", { estCostUsd: 2 }), row("b", "m2", { estCostUsd: 2 })];
    const est = estimatePlan(rows, { isLocal, turnBudgetUsd: 1.5, dailyRemainingUsd: 3 });
    expect(est.violations).toEqual([
      { kind: "turn-budget", severity: "hard", milestoneId: "m1", estimateUsd: 2, limitUsd: 1.5 },
      { kind: "turn-budget", severity: "hard", milestoneId: "m2", estimateUsd: 2, limitUsd: 1.5 },
      { kind: "daily-limit", severity: "hard", estimateUsd: 4, remainingUsd: 3 },
    ]);
    expect(est.hardViolations).toHaveLength(3);
    expect(est.hardViolations[0]).toBe(describeViolation(est.violations[0]!));
  });

  it("flags members the folder policy refuses", () => {
    const rows = [row("a", "m1", { worker: "banned:x", reviewer: "banned:y" })];
    const est = estimatePlan(rows, { isLocal, allows: (p) => p !== "banned" });
    expect(est.violations).toEqual([
      { kind: "folder-policy", severity: "hard", taskId: "a", member: "banned:x", as: "worker" },
      { kind: "folder-policy", severity: "hard", taskId: "a", member: "banned:y", as: "reviewer" },
    ]);
  });

  it("no known figure: totals are null", () => {
    const est = estimatePlan([row("a", "m1", { estCostUsd: null, estMs: null })], { isLocal });
    expect(est.totals).toEqual({ costUsd: null, ms: null, unknownCostRows: 1 });
  });
});

describe("variants", () => {
  const tiers: Record<string, ModelTier | null> = {
    "cloud:cheap": "cheap",
    "cloud:mid": "balanced",
    "cloud:mid2": "balanced",
    "cloud:best": "best",
    "cloud:mystery": null,
    "local:x": null,
  };
  const costs: Record<string, number | null> = {
    "cloud:cheap": 0.1,
    "cloud:mid": 0.5,
    "cloud:mid2": 0.3,
    "cloud:best": 2,
    "cloud:mystery": 0.01,
    "local:x": null,
  };
  const ctx = (refs: string[], extra: Partial<VariantContext> = {}): VariantContext => ({
    members: refs.map(member),
    strength: (m) => tiers[m.ref] ?? null,
    isLocal: (m) => m.providerId === "local",
    estimate: (m): RowEstimate => ({ basis: "measured", samples: 9, estCostUsd: costs[m.ref] ?? null, estMs: 10, priceOnly: false, reason: "measured: median of 9 runs" }),
    ...extra,
  });
  const all = Object.keys(tiers);

  it("cheaper picks the lowest known cost among members not weaker than the current worker", () => {
    const out = cheaperVariant([row("a", "m1", { worker: "cloud:mid", estCostUsd: 0.5 })], ctx(all));
    // cheap is weaker, mystery has no tier: mid2 at 0.3 wins.
    expect(out[0]).toMatchObject({ worker: "cloud:mid2", estCostUsd: 0.3, basis: "measured", samples: 9 });
  });

  it("cheaper keeps the row when nothing is cheaper", () => {
    const r = row("a", "m1", { worker: "cloud:best", estCostUsd: 2 });
    expect(cheaperVariant([r], ctx(all))[0]).toEqual(r);
  });

  it("from a local worker any cloud member is not weaker", () => {
    const out = cheaperVariant([row("a", "m1", { worker: "local:x", estCostUsd: null })], ctx(all));
    expect(out[0]!.worker).toBe("cloud:mystery");
  });

  it("quality picks the highest tier; a tie goes to the better acceptance rate", () => {
    const acceptance = (m: TeamMember) => (m.ref === "cloud:mid2" ? 0.9 : 0.5);
    const out = qualityVariant([row("a", "m1", { worker: "cloud:cheap" })], ctx(["cloud:cheap", "cloud:mid", "cloud:mid2"], { acceptance }));
    expect(out[0]!.worker).toBe("cloud:mid2");
    expect(qualityVariant([row("a", "m1", { worker: "cloud:cheap" })], ctx(all))[0]!.worker).toBe("cloud:best");
  });

  it("re-picks the reviewer for a changed worker when given reviewerFor", () => {
    const reviewerFor = (w: TeamMember) => (w.ref === "cloud:best" ? member("cloud:mid") : null);
    const out = qualityVariant([row("a", "m1", { worker: "cloud:cheap", reviewer: "cloud:best" })], ctx(all, { reviewerFor }));
    expect(out[0]).toMatchObject({ worker: "cloud:best", reviewer: "cloud:mid" });
  });

  it("without reviewerFor, a reviewer equal to the new worker is dropped", () => {
    const out = qualityVariant([row("a", "m1", { worker: "cloud:cheap", reviewer: "cloud:best" })], ctx(all));
    expect(out[0]).toMatchObject({ worker: "cloud:best", reviewer: null });
  });
});

describe("planDetailFor", () => {
  const plan = (n: number, cost: number | null) => ({
    rows: Array.from({ length: n }, (_, i) => row(`t${i}`, "m")),
    totals: { costUsd: cost, ms: null, unknownCostRows: 0 },
  });

  it("is compact at or under the defaults (4 tasks, $1) and full above either", () => {
    expect(planDetailFor(plan(4, 1), undefined, false)).toBe("compact");
    expect(planDetailFor(plan(5, 0.1), undefined, false)).toBe("full");
    expect(planDetailFor(plan(1, 1.01), undefined, false)).toBe("full");
    expect(planDetailFor(plan(1, null), undefined, false)).toBe("compact");
  });

  it("follows the config and /plan forces full", () => {
    expect(planDetailFor(plan(5, 0), { fullPlanAboveTasks: 10 }, false)).toBe("compact");
    expect(planDetailFor(plan(1, 0.5), { fullPlanAboveUsd: 0.25 }, false)).toBe("full");
    expect(planDetailFor(plan(1, 0), undefined, true)).toBe("full");
  });
});
