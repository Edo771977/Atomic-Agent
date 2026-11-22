import { decisionStatusOf, projectExpectation, type ProjectState } from "../session/session-project.js";
import { openBacklog, openSeeds, promotedForPlan } from "../session/project-backlog.js";
import { planReviewLine } from "../tools/fusion/plan-review-record.js";
import { frameUntrustedText } from "../tools/untrusted-tool-output.js";

/** The backlog's text is written by models or by hand: framed as data wherever the director reads it (issue #111 review). */
export const BACKLOG_DATA_SOURCE = "the project's backlog items (written by models or by hand)";

/** Open, promoted and seed items as data lines, framed; null when none. */
export function backlogDataBlock(lines: readonly string[]): string | null {
  return lines.length === 0 ? null : frameUntrustedText(lines.join("\n"), BACKLOG_DATA_SOURCE);
}

/** Longest `what` the digest quotes; the brief itself is the person's card, not the prompt's. */
const WHAT_CHARS = 300;

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/**
 * The `### fusion project` section (issue #39): where the fusion project
 * stands, for the director. In the step-mutable tail, never the cached
 * prefix: a director tool or a person's decision changes it between
 * steps and turns. Null without a project.
 *
 * It says the brief's status and success criteria, the plan's status,
 * the milestones, the gate, and what to do next — including, while a
 * gate is open, not to delegate.
 */
export function renderProjectDigest(project: ProjectState | undefined): string | null {
  if (project === undefined) return null;
  const lines: string[] = [];
  if (project.cancelledAt !== undefined) {
    return "The person cancelled this project. Do not delegate for it; a new project starts with project.brief.";
  }
  const brief = project.brief;
  if (brief !== undefined) {
    lines.push(`brief: ${brief.status} v${brief.version} — ${clip(brief.what, WHAT_CHARS)}`);
    if (brief.successCriteria.length > 0) {
      lines.push("success criteria (ids for contract checks' `criteria`):", ...brief.successCriteria.map((c) => `- ${c.id}: ${c.text}`));
    }
    // Issue #112: the plan must cite every active one; the person's status is theirs to set.
    if ((brief.decisions ?? []).length > 0) {
      lines.push("decisions (cite each active one in a plan task's `decisions`):", ...brief.decisions!.map((d) => {
        const status = decisionStatusOf(project, d.id);
        return `- ${d.id}: ${d.text}${status === "active" ? "" : ` (${status} by the person)`}`;
      }));
    }
  }
  const plan = project.plan;
  if (plan !== undefined) {
    lines.push(`plan: ${plan.status} v${plan.version}, ${plan.rows.length} task${plan.rows.length === 1 ? "" : "s"}`);
  }
  if (project.milestones.length > 0) {
    lines.push(`milestones: ${project.milestones.map((m) => `${m.id} (${m.kind}) ${m.state}`).join(", ")}`);
  }
  // Issue #111: the backlog is proposals; the person's calls on it are theirs.
  if ((project.backlog ?? []).length > 0) {
    lines.push(`backlog: ${openBacklog(project).length} open; only the person promotes or drops an item`);
    const promoted = promotedForPlan(project);
    const seeds = openSeeds(project);
    const complete = projectExpectation(project).kind === "complete";
    if (promoted.length > 0 || seeds.length > 0) {
      lines.push("promoted by the person: take each into the next plan (a new milestone or task, through the plan gate) on a task that cites its id in `backlog`; seeds: tell the person when a condition looks met.");
    }
    const block = backlogDataBlock([
      ...promoted.map((b) => `promoted: ${b.id} ${clip(b.title, 120)}`),
      ...seeds.map((b) => `seed: ${b.id} ${clip(b.title, 120)} (when: ${clip(b.condition!, 160)})`),
      // At the close every open item is listed, for the final reply.
      ...(complete ? openBacklog(project).filter((b) => b.condition === undefined).map((b) => `open: ${b.id} ${clip(b.title, 120)}`) : []),
    ]);
    if (block !== null) lines.push(block);
  }
  const gate = project.gate;
  if (gate.kind !== "none") {
    const what = gate.kind === "brief" ? "the brief" : gate.kind === "plan" ? "the plan" : `milestone ${gate.id}'s result`;
    lines.push(`gate: ${what} waits for the person. Reply and stop; do not delegate until they decide.`);
  }
  const next = projectExpectation(project);
  switch (next.kind) {
    case "draft_brief":
      lines.push("next: draft the brief with project.brief, then reply.");
      break;
    case "draft_plan":
      if (plan?.status === "draft" && plan.review?.sentBack === true) {
        // Issue #118: the plan reviewer sent the draft back; it is not at the person's gate yet.
        lines.push("next: revise the plan with project.plan to address the plan reviewer's notes; it reaches the person when the reviewer passes it or the rounds run out. Do not delegate.");
        const notes = plan.review.results.filter((r) => r.verdict !== "pass").map(planReviewLine);
        if (notes.length > 0) lines.push("plan reviewer's notes:", frameUntrustedText(notes.join("\n"), "the plan reviewer's answer (a model)"));
      } else lines.push("next: draft the plan with project.plan, then reply.");
      break;
    case "run_milestone": {
      const tasks = plan?.rows.filter((r) => r.milestoneId === next.id).map((r) => r.taskId) ?? [];
      lines.push(
        `next: run milestone ${next.id}: delegate ${tasks.join(", ") || "its tasks"} (the plan's task ids and workers), review, then report it with project.milestone and reply.`,
      );
      const correction = project.milestones.find((m) => m.id === next.id)?.corrections?.at(-1);
      if (correction !== undefined) lines.push(`correction from the person: ${correction.note}`);
      break;
    }
    case "complete":
      if (next.openBacklog === undefined && next.promotedNotDone === undefined) lines.push("next: every milestone is reviewed; the project is complete.");
      else {
        const left = [
          ...(next.openBacklog === undefined ? [] : [`${next.openBacklog} backlog item${next.openBacklog === 1 ? "" : "s"} still open`]),
          ...(next.promotedNotDone === undefined ? [] : [`${next.promotedNotDone} promoted backlog item${next.promotedNotDone === 1 ? "" : "s"} not done`]),
        ];
        lines.push(`next: every milestone is reviewed; the project is complete with ${left.join(" and ")} (listed in the backlog data): say so in your final reply.`);
      }
      break;
    default:
      break;
  }
  return lines.join("\n");
}
