/**
 * A fusion project gate as plain text (issue #39), for the surfaces
 * without a card: the CLI `run` summary and the Telegram fallback. Pure;
 * the same facts the TUI card shows (brief, untrusted warning, rows with
 * worker, reviewer, estimate and basis, totals, violations, milestones)
 * and the verdicts the gate allows. An unknown cost or time is said, never
 * shown as zero.
 */

import type { ProjectCriterionBasisSummary, ProjectGateBacklog, ProjectGateDecision, ProjectGateView } from "./project-gate-view.js";
import type { CriterionFactState, ProjectCriterion, ProjectCriterionFact, ProjectMilestoneAttachment } from "./session-project.js";

const FACT_MARK: Record<CriterionFactState, string> = { passed: "✓", failed: "✕", unverified: "?" };

export function summarizeCriterionBases(facts: readonly ProjectCriterionFact[]): ProjectCriterionBasisSummary {
  const counts = { check: 0, vision: 0, person: 0, unrecorded: 0 };
  for (const fact of facts) counts[fact.basis?.kind ?? "unrecorded"] += 1;
  return counts;
}

export function criterionBasisSummaryLine(counts: ProjectCriterionBasisSummary): string {
  const total = counts.check + counts.vision + counts.person + counts.unrecorded;
  const labels = [
    counts.check > 0 ? `${counts.check} measured` : "",
    counts.vision > 0 ? `${counts.vision} judged by a model` : "",
    counts.person > 0 ? `${counts.person} declared by you` : "",
    counts.unrecorded > 0 ? `${counts.unrecorded} basis not recorded` : "",
  ];
  return `${total} ${total === 1 ? "criterion" : "criteria"}: ${labels.filter(Boolean).join(", ")}`;
}

/** A claim needs a passed criterion cited by bracketed ID or by its full text in the same sentence. */
export function directorReportWarnings(
  report: string,
  facts: readonly ProjectCriterionFact[],
  criteria: readonly ProjectCriterion[],
): string[] {
  const passed = facts.filter((fact) => fact.state === "passed");
  const textById = new Map(criteria.map(({ id, text }) => [id, text.toLowerCase()]));
  return report
    .split(/\r?\n/u)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/u))
    .map((sentence) => sentence.trim())
    .filter((sentence) => {
      const text = sentence.toLowerCase();
      if (!/\b(?:verificato|verified|funziona|works)\b/u.test(text)) return false;
      return !passed.some(({ id }) => {
        const criterion = textById.get(id);
        return text.includes(`[${id}]`) || (criterion !== undefined && criterion.length > 0 && text.includes(criterion));
      });
    });
}

export const directorReportWarningLine = (sentence: string): string =>
  `Warning: no matching passed criterion fact for director claim: ${sentence}`;

export function criterionBasisLabel(basis: ProjectCriterionFact["basis"]): string {
  switch (basis?.kind) {
    case "check": return "measured";
    case "person": return "declared by you";
    case "vision": return `judged by ${basis.model}`;
    default: return "basis not recorded";
  }
}

/**
 * One criterion fact as a line (issue #40), e.g. "✓ c1 passed: Runs
 * offline" or "? c2 unverified: Looks right (no vision-capable
 * reviewer)", or "~ c3 passed with reservations: …" (issue #110). The
 * text is the brief's when it names the id.
 */
export function criterionFactLine(fact: ProjectCriterionFact, criteria: readonly ProjectCriterion[] | undefined): string {
  const text = criteria?.find((c) => c.id === fact.id)?.text;
  // Issue #110: passed only on checks that may pass on the wrong thing — never plain green.
  const reserved = fact.state === "passed" && fact.reservation !== undefined;
  const mark = reserved ? "~" : (FACT_MARK[fact.state] ?? "?");
  const state = reserved ? "passed with reservations" : fact.state;
  const notes = [...(fact.why ? [fact.why] : []), ...(reserved ? [`reservations: ${fact.reservation}`] : [])];
  return `${mark} ${fact.id} ${state}${text === undefined ? "" : `: ${text}`}${notes.length === 0 ? "" : ` (${notes.join("; ")})`} · ${criterionBasisLabel(fact.basis)}`;
}

/**
 * One brief decision as a line (issue #112), e.g. "d1 Use SQLite (active;
 * cited by t1, t2)", "d2 No new dependencies (active; cited by no task)"
 * or "d3 Formal tone (deferred)".
 */
export function decisionLine(decision: ProjectGateDecision): string {
  const cited = decision.status !== "active" ? "" : `; cited by ${decision.citedBy.length === 0 ? "no task" : decision.citedBy.join(", ")}`;
  return `${decision.id} ${decision.text} (${decision.status}${cited})`;
}

/** A seed's hint at a plan or milestone gate (issue #111): the person decides; nothing activates by itself. */
export const seedHint = (id: string, title: string, condition: string): string => `seed ${id} "${title}" (when: ${condition}): yours to promote if it is met`;

/** The backlog in one line (issue #111), e.g. "Backlog: 2 open (1 seed), 1 promoted for the next plan". */
export function backlogSummary(backlog: ProjectGateBacklog): string {
  const seeds = backlog.seeds.length === 0 ? "" : ` (${backlog.seeds.length} seed${backlog.seeds.length === 1 ? "" : "s"})`;
  const promoted = backlog.promoted.length === 0 ? "" : `, ${backlog.promoted.length} promoted for the next plan`;
  return `Backlog: ${backlog.open} open${seeds}${promoted}; atomic-agent project backlog lists it`;
}

/** The active decisions no plan task cites (issue #112): what blocks the plan, and what the person may defer. */
export function uncitedDecisions(view: Pick<ProjectGateView, "decisions">): string[] {
  return (view.decisions ?? []).filter((d) => d.status === "active" && d.citedBy.length === 0).map((d) => d.id);
}

/** A picture's caption with the criteria it shows, e.g. "The board [c1, c2]". */
export function attachmentLabel(attachment: ProjectMilestoneAttachment): string {
  const ids = attachment.criteria ?? [];
  return ids.length === 0 ? attachment.caption : `${attachment.caption} [${ids.join(", ")}]`;
}

/**
 * Plan rows carry no file list: what approving the plan lets the tasks
 * write is the chat's folder (the fusion write scope). Every surface says so.
 */
export const PROJECT_WRITE_SCOPE_NOTE =
  "Approving lets these tasks write in this chat's folder (the session's working directory); a write outside it still asks.";

/** The plan gate's warning for a plan drafted after outside content (every surface shows it). */
export const PLAN_UNTRUSTED_WARNING =
  "⚠ The plan was drafted after outside content entered the chat. Check its tasks and workers before approving: approving lets them run without asking again.";

const usd = (n: number | null): string => (n === null ? "cost unknown" : n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

function duration(ms: number | null): string {
  if (ms === null) return "time unknown";
  const s = Math.round(ms / 1000);
  if (s < 60) return `~${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `~${m}m${s % 60 === 0 ? "" : `${String(s % 60).padStart(2, "0")}s`}`;
  return `~${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

const MARK: Record<string, string> = {
  planned: "·", approved: "▸", in_progress: "◐", done: "✓", failed: "✕", reviewed: "✔",
};

/** The gate's headline, e.g. "The project plan waits for your approval". */
export function projectGateHeadline(view: ProjectGateView): string {
  switch (view.gate.kind) {
    case "brief":
      return "The project brief waits for your approval";
    case "plan":
      return "The project plan waits for your approval";
    case "milestone": {
      const id = view.gate.id;
      const m = view.milestones.find((x) => x.id === id);
      return `Milestone "${m?.title ?? id}" ${m?.state === "failed" ? "failed" : "is done"} and waits for your review`;
    }
    case "none":
      return "Nothing in the project waits for you";
  }
}

export function formatProjectGateText(view: ProjectGateView): string {
  const out: string[] = [`${projectGateHeadline(view)} (version ${view.version}).`];
  const brief = view.brief;
  if (brief?.draftedAfterUntrusted) {
    out.push("  ⚠ The brief was drafted after outside content entered the chat. Read it before approving.");
  }
  if (brief !== null) {
    out.push(`  What: ${brief.what}`);
    if (view.gate.kind === "brief") {
      out.push(`  For: ${brief.users}`, `  How: ${brief.how}`);
    }
    if (brief.successCriteria.length > 0) out.push(`  Done when: ${brief.successCriteria.join("; ")}`);
  }
  if ((view.decisions ?? []).length > 0) out.push("  Decisions:", ...view.decisions!.map((d) => `    ${decisionLine(d)}`));
  if (view.gate.kind !== "brief" && view.plan?.draftedAfterUntrusted) {
    out.push(`  ${PLAN_UNTRUSTED_WARNING}`);
  }
  if (view.gate.kind !== "brief") {
    const rows = view.plan?.rows ?? [];
    for (const r of rows) {
      const basis = r.basis === "measured" ? `measured (${r.samples} runs)` : "preset";
      out.push(
        `  ${r.taskId} ${r.title} [${r.milestoneId}]: worker ${r.worker} · review ${r.reviewer ?? "none"} · ${r.local === true ? "$0.00 (local)" : usd(r.estCostUsd)} · ${duration(r.estMs)} · ${basis}`,
      );
    }
    if (view.plan !== null && rows.length > 0) {
      const t = view.plan.totals;
      const unpriced = t.unknownCostRows > 0 ? ` (+${t.unknownCostRows} unpriced)` : "";
      out.push(`  Total: ${rows.length} task${rows.length === 1 ? "" : "s"} · ${usd(t.costUsd)}${unpriced} · ${duration(t.ms)}`);
      if (view.gate.kind === "plan") {
        out.push(`  ${PROJECT_WRITE_SCOPE_NOTE}`);
      }
    }
    if (view.milestones.length > 0) {
      out.push(`  Milestones: ${view.milestones.map((m) => `${MARK[m.state] ?? "·"} ${m.title}`).join("  ")}`);
    }
    if (view.gate.kind === "milestone") {
      const id = view.gate.id;
      const milestone = view.milestones.find((m) => m.id === id);
      if (milestone?.summary) out.push(`  Director report: ${milestone.summary}`);
      for (const note of milestone?.reportNotes ?? []) out.push(`  ${note}`);
      for (const warning of milestone?.directorReportWarnings ?? []) out.push(`  ${directorReportWarningLine(warning)}`);
      const facts = milestone?.criteriaFacts ?? [];
      if (facts.length > 0) out.push(`  ${criterionBasisSummaryLine(milestone?.criteriaBasisSummary ?? summarizeCriterionBases(facts))}`, ...facts.map((f) => `    ${criterionFactLine(f, view.brief?.criteria)}`));
      for (const a of milestone?.attachments ?? []) out.push(`  Picture: ${attachmentLabel(a)} — ${a.path}`);
    }
  }
  if (view.backlog !== undefined) out.push(`  ${backlogSummary(view.backlog)}`);
  for (const v of view.violations) out.push(`  ${v.severity === "hard" ? "✕ over a hard cap:" : "! note:"} ${v.message}`);
  for (const hint of view.hints ?? []) out.push(`  hint: ${hint}`);
  out.push(`  Allowed: ${view.allowedVerdicts.join(", ")}`);
  return out.join("\n");
}

/** One line for an automatic approval, e.g. for `--auto-approve-project`. */
export function projectApprovalLine(view: ProjectGateView): string {
  switch (view.gate.kind) {
    case "brief":
      return `approved the brief (version ${view.version}): ${view.brief?.what ?? ""}`.trimEnd();
    case "plan": {
      const t = view.plan?.totals ?? { costUsd: null, ms: null, unknownCostRows: 0 };
      return `approved the plan (version ${view.version})${view.plan?.draftedAfterUntrusted ? " [drafted after outside content]" : ""}: ${view.plan?.rows.length ?? 0} tasks, ${usd(t.costUsd)}${t.unknownCostRows > 0 ? ` (+${t.unknownCostRows} unpriced)` : ""}, ${duration(t.ms)}`;
    }
    case "milestone": {
      const id = view.gate.id;
      return `approved milestone "${view.milestones.find((m) => m.id === id)?.title ?? id}" (version ${view.version})`;
    }
    case "none":
      return "nothing to approve";
  }
}

/**
 * Why an approval for `version` is refused when the gate moved on, e.g.
 * "the plan changed since version 2; current is 3"; null when `version`
 * is the gate's current one. Text surfaces (Telegram `/plan approve <v>`,
 * CLI `--approve <v>`) approve only the version the person read.
 */
export function staleApprovalReason(view: ProjectGateView, version: number): string | null {
  if (view.version === version) return null;
  const what = view.gate.kind === "brief" ? "the brief" : view.gate.kind === "milestone" ? "the milestone's result" : "the plan";
  return `${what} changed since version ${version}; current is ${view.version ?? "none"}`;
}
