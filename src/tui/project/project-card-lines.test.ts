import { describe, expect, it } from "vitest";

import { pathToFileURL } from "node:url";

import { FIXTURE_SHOT_PATH, fixtureProjectGateView, withFixtureMilestoneEvidence } from "../../session/project-gate-view-fixtures.js";
import type { ProjectGateView } from "../../session/project-gate-view.js";
import { projectCardLines, projectResumeLine } from "./project-card-lines.js";
import { reduceProjectCard, type ProjectCardState } from "./project-card-state.js";

function card(view: ProjectGateView, full?: boolean): ProjectCardState {
  return reduceProjectCard(null, { type: "project_card_shown", sessionId: "s1", view, ...(full ? { full } : {}) })!;
}

const text = (c: ProjectCardState): string =>
  projectCardLines(c, 90).map((l) => l.segments.map((s) => s.text).join("")).join("\n");

const planWith = (plan: Partial<NonNullable<ProjectGateView["plan"]>>): ProjectGateView => {
  const base = fixtureProjectGateView({ kind: "plan" });
  return { ...base, plan: { ...base.plan!, ...plan } };
};

describe("project card lines", () => {
  it("labels the lesson coverage section", () => {
    const view = fixtureProjectGateView({ kind: "plan" }, {
      lessonCoverage: [{ id: "storage", title: "Keep local", deferred: false, citedBy: ["t1"], missingFrom: ["t2"] }],
    });
    expect(text(card(view))).toMatch(/Lessons:[\s\S]*storage.*t1.*missing from t2/);
  });
  it("compact: brief line, totals with unpriced rows, buttons; no row table", () => {
    const out = text(card(fixtureProjectGateView({ kind: "plan" })));
    expect(out).toContain("PROJECT PLAN — YOUR APPROVAL");
    expect(out).toContain("What: A small puzzle game");
    expect(out).toContain("Total: 2 tasks · $0.12 (+1 task unpriced) · ~1m30s");
    expect(out).not.toContain("Board and pieces");
    expect(out).toContain("/plan shows the full plan");
    expect(out).toMatch(/a approve .* e edit rows .* c cheaper .* q quality .* x cancel project/);
  });

  it("full (view.detail or /plan): every row with worker, reviewer, estimate and basis", () => {
    const out = text(card(fixtureProjectGateView({ kind: "plan" }), true));
    expect(out).toContain("t1 Board and pieces [m1]");
    expect(out).toContain("worker model-a · review model-b · $0.12 · ~1m30s");
    expect(out).toContain("measured (6 runs): best measured acceptance");
    expect(out).toContain("worker model-c · review no review · cost unknown · time unknown");
    expect(out).toContain("preset: insufficient data, chosen from the preset");
    expect(out).toContain("• Ten levels");
    expect(text(card(planWith({ detail: "full" })))).toContain("t2 Level screen");
  });

  it.each([
    ["draft", "Draft"],
    ["review", "Review"],
    ["final", "Final"],
  ] as const)("shows a readable label for a %s milestone", (kind, label) => {
    const view = fixtureProjectGateView({ kind: "plan" });
    const milestones = view.milestones.map((m) => ({ ...m, kind }));
    expect(text(card({ ...view, milestones }, true))).toContain(`(${label})`);
  });

  it("shows a local row as $0.00 (local), not unpriced (issue #54)", () => {
    const base = fixtureProjectGateView({ kind: "plan" });
    const rows = base.plan!.rows.map((r) => r.taskId === "t2" ? { ...r, estCostUsd: 0, local: true as const } : r);
    const out = text(card({ ...base, plan: { ...base.plan!, rows, totals: { ...base.plan!.totals, unknownCostRows: 0 } } }, true));
    expect(out).toContain("worker model-c · review no review · $0.00 (local) · time unknown");
    expect(out).not.toContain("unpriced");
  });

  it("shows the view's hints and hides edit rows when the plan is not editable (issue #54)", () => {
    const base = fixtureProjectGateView({ kind: "plan" });
    const view: ProjectGateView = { ...base, hints: ["only one worker available: configure llm.runMode.fusion.team to choose"], plan: { ...base.plan!, editable: false } };
    const out = text(card(view));
    expect(out).toContain("only one worker available: configure llm.runMode.fusion.team to choose");
    expect(out).not.toContain("edit rows");
    expect(out).toMatch(/a approve .* c cheaper/);
  });

  it("says the approved write scope is the session folder (rows carry no file list)", () => {
    expect(text(card(fixtureProjectGateView({ kind: "plan" })))).toContain("Approving lets these tasks write in this chat's folder");
    expect(text(card(fixtureProjectGateView({ kind: "plan" }), true))).toContain("Approving lets these tasks write in this chat's folder");
    expect(text(card(fixtureProjectGateView({ kind: "brief" })))).not.toContain("write in this chat's folder");
  });

  it("warns on a brief drafted after untrusted content", () => {
    const base = fixtureProjectGateView({ kind: "brief" });
    const out = text(card({ ...base, brief: { ...base.brief!, draftedAfterUntrusted: true } }));
    expect(out).toMatch(/drafted after outside content/);
    expect(out).toContain("• Runs in a browser");
  });

  it("warns on a plan drafted after untrusted content", () => {
    const base = fixtureProjectGateView({ kind: "plan" });
    expect(text(card(base))).not.toMatch(/plan was drafted after outside content/);
    const out = text(card({ ...base, plan: { ...base.plan!, draftedAfterUntrusted: true } }));
    expect(out).toMatch(/plan was drafted after outside content/);
  });

  it("lists violations, hard ones marked", () => {
    const out = text(card(fixtureProjectGateView({ kind: "plan" }, {
      violations: [
        { kind: "daily-limit", severity: "hard", message: "over today's limit" },
        { kind: "local-slots", severity: "warn", message: "local tasks run in turns" },
      ],
    })));
    expect(out).toContain("✕ over today's limit");
    expect(out).toContain("! local tasks run in turns");
  });

  it("milestone gate: the milestone's summary and the correct button", () => {
    const out = text(card(fixtureProjectGateView({ kind: "milestone", id: "m1" }, { allowedVerdicts: ["approve", "edit", "cancel"] })));
    expect(out).toContain("MILESTONE Base DONE — YOUR REVIEW");
    expect(out).toContain("Board renders");
    expect(out).toContain("e correct");
  });

  it("milestone gate: criteria facts by tone and each picture's caption with its path as a file link (issue #40)", () => {
    const c = card(withFixtureMilestoneEvidence(fixtureProjectGateView({ kind: "milestone", id: "m1" }, { allowedVerdicts: ["approve", "edit", "cancel"] })));
    const out = text(c);
    expect(out).toContain("✓ c1 passed: Runs in a browser");
    expect(out).toContain("? c2 unverified: Ten levels (no vision-capable reviewer)");
    expect(out).toContain("The board at start [c1]");
    const lines = projectCardLines(c, 90);
    const link = lines.flatMap((l) => l.segments).find((s) => s.link !== undefined);
    expect(link).toMatchObject({ text: FIXTURE_SHOT_PATH, link: pathToFileURL(FIXTURE_SHOT_PATH).href });
    const unverified = lines.flatMap((l) => l.segments).find((s) => s.text.includes("c2 unverified"));
    expect(unverified?.tone).toBe("warn");
    // Not on the plan gate's compact card.
    expect(text(card(withFixtureMilestoneEvidence(fixtureProjectGateView({ kind: "plan" }))))).not.toContain("The board at start");
  });

  it.each([
    [{ valid: 4, unsigned: 0, problems: 0 }, "Evidence: 4 signed", "ok"],
    [{ valid: 2, unsigned: 1, problems: 0 }, "Evidence: 2 signed, 1 unsigned (not verifiable; the signing key may have been unavailable)", "warn"],
    [{ valid: 0, unsigned: 0, problems: 1 }, "Evidence: 1 problem", "error"],
  ] as const)("shows evidence status and verification guidance as text", (evidenceReceipts, expected, tone) => {
    const view = fixtureProjectGateView({ kind: "milestone", id: "m1" });
    view.milestones = view.milestones.map(m => m.id === "m1" ? { ...m, evidenceReceipts } : m);
    const segments = projectCardLines(card(view), 90).flatMap(line => line.segments);
    expect(segments.filter(s => s.tone === tone).map(s => s.text.trim()).join(" ")).toContain(expected);
    if (evidenceReceipts.unsigned || evidenceReceipts.problems) {
      expect(segments.map(s => s.text.trim()).join(" ")).toContain("Run atomic-agent project verify");
    }
  });

  it("names the project folder in the evidence verification hint", () => {
    const view = fixtureProjectGateView({ kind: "milestone", id: "m1" });
    view.milestones = view.milestones.map(m => m.id === "m1" ? {
      ...m, evidenceReceipts: { valid: 0, unsigned: 0, problems: 1, folder: "/work/My Project" },
    } : m);
    expect(text(card(view))).toContain('Run atomic-agent project verify "/work/My Project"');
  });

  it("note mode shows the typed correction", () => {
    let c = card(fixtureProjectGateView({ kind: "milestone", id: "m1" }, { allowedVerdicts: ["approve", "edit", "cancel"] }));
    c = reduceProjectCard(c, { type: "project_card_mode_set", mode: "note" })!;
    c = reduceProjectCard(c, { type: "project_card_note_set", note: "bigger tiles" })!;
    expect(text(c)).toContain("bigger tiles");
  });
});

describe("project resume line", () => {
  it("says what was done last and what is next", () => {
    const v = fixtureProjectGateView({ kind: "none" }, {
      milestones: [
        { id: "m1", title: "Base", kind: "base", state: "reviewed", runIds: ["r1"], updatedAt: 1, estCostUsd: null, estMs: null },
        { id: "m2", title: "UI", kind: "ui", state: "approved", runIds: [], updatedAt: 1, estCostUsd: null, estMs: null },
      ],
      expectation: { kind: "run_milestone", id: "m2" },
    });
    expect(projectResumeLine(v)).toBe("Project — last done: Base · next: UI");
  });

  it("offers /fusion resume for a milestone cut off mid-run", () => {
    const v = fixtureProjectGateView({ kind: "none" }, {
      milestones: [{ id: "m1", title: "Base", kind: "base", state: "in_progress", runIds: ["r1"], updatedAt: 1, estCostUsd: null, estMs: null }],
      expectation: { kind: "run_milestone", id: "m1" },
    });
    expect(projectResumeLine(v)).toBe("Project — last done: nothing yet · next: Base · Base was cut off mid-run: /fusion resume continues it");
  });

  it("points at /plan for a gate waiting on the person; nothing for a cancelled project", () => {
    expect(projectResumeLine(fixtureProjectGateView({ kind: "plan" }))).toContain("next: your approval of the plan (/plan)");
    expect(projectResumeLine(fixtureProjectGateView({ kind: "none" }, { expectation: { kind: "cancelled" } }))).toBeNull();
  });

  it("lists the brief's decisions with status and citing tasks, and offers defer (issue #112)", () => {
    const view = fixtureProjectGateView({ kind: "plan" }, { decisions: [
      { id: "d1", text: "Use SQLite", status: "active", citedBy: ["t1"] },
      { id: "d2", text: "No new dependencies", status: "active", citedBy: [] },
      { id: "d3", text: "Formal tone", status: "deferred", citedBy: [] },
    ] });
    const out = text(card(view));
    expect(out).toContain("d1 Use SQLite (active; cited by t1)");
    expect(out).toContain("d2 No new dependencies (active; cited by no task)");
    expect(out).toContain("d3 Formal tone (deferred)");
    expect(out).toContain(" d defer d2 ");
  });

  it("lists the promoted backlog items at the plan gate with the tasks citing each (issue #146)", () => {
    const view = fixtureProjectGateView({ kind: "plan" }, { backlog: { open: 0, seeds: [], stale: [], items: [], promoted: [
      { id: "b1", title: "Export PDF", citedBy: ["t2"] },
      { id: "b2", title: "Sounds", citedBy: [] },
      { id: "b3", title: "Dark mode", deferred: true, citedBy: [] },
    ] } });
    const out = text(card(view));
    expect(out).toContain("promoted b1 Export PDF (cited by t2)");
    expect(out).toContain("promoted b2 Sounds (cited by no task)");
    expect(out).toContain("promoted b3 Dark mode (deferred)");
  });
});

describe("the project card's backlog (issue #111)", () => {
  const backlog = {
    open: 2,
    seeds: [{ id: "b1", title: "Sounds", condition: "when the UI exists" }],
    promoted: [{ id: "b3", title: "PDF export" }],
    stale: [],
    items: [],
  };

  it("shows the open count and the seeds with their condition at a plan or milestone gate", () => {
    const out = text(card({ ...fixtureProjectGateView({ kind: "plan" }), backlog }));
    expect(out).toContain("Backlog: 2 open · 1 seed · 1 promoted");
    expect(out).toContain("seed b1 Sounds — when the UI exists");
    const none = text(card({ ...fixtureProjectGateView({ kind: "brief" }), backlog }));
    expect(none).toContain("Backlog: 2 open · 1 seed · 1 promoted");
    expect(none).not.toContain("seed b1");
  });

  it("marks changed and removed calls, and offers only Reopen for a removed item", () => {
    const view: ProjectGateView = { ...fixtureProjectGateView({ kind: "plan" }), backlog: { ...backlog,
      items: [{ id: "b1", title: "Sounds", state: "open", source: "director", createdAt: 1 }],
      stale: [{ id: "b1", state: "promoted", reason: "changed" }, { id: "b2", state: "dropped", reason: "removed" }] } };
    let c = card(view);
    expect(text(c)).toContain("b Backlog");
    c = reduceProjectCard(c, { type: "project_card_mode_set", mode: "backlog" })!;
    expect(text(c)).toContain("changed since you promoted it");
    c = reduceProjectCard(c, { type: "project_card_backlog_moved", delta: 1 })!;
    expect(text(c)).toContain("removed outside Atomic Agent");
    expect(text(c)).toContain("r Reopen");
    expect(text(c)).not.toContain("p Promote");
  });

  it("says nothing without a backlog, and the resume line counts open items", () => {
    expect(text(card(fixtureProjectGateView({ kind: "plan" })))).not.toContain("Backlog:");
    const view = { ...fixtureProjectGateView({ kind: "plan" }), backlog };
    expect(projectResumeLine(view)).toContain(" · backlog: 2 open");
  });
});

describe("the project card's seeds come from the view's backlog, not a hint prefix (review)", () => {
  it("drops only the hints that repeat a listed seed", () => {
    const backlog = { open: 1, seeds: [{ id: "b1", title: "Sounds", condition: "when the UI exists" }], promoted: [], stale: [], items: [] };
    const hints = ['seed b1 "Sounds" (when: when the UI exists): yours to promote if it is met', "seed data missing for t2"];
    const out = text(card({ ...fixtureProjectGateView({ kind: "plan" }), backlog, hints }));
    expect(out).toContain("seed b1 Sounds — when the UI exists");
    expect(out).not.toContain('seed b1 "Sounds"');
    expect(out).toContain("ℹ seed data missing for t2");
  });
});
