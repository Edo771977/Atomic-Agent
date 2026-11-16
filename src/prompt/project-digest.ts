import { projectExpectation, type ProjectState } from "../session/session-project.js";

/** Longest `what` the digest quotes; the brief itself is the person's card, not the prompt's. */
const WHAT_CHARS = 300;

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/**
 * The `### project` section (issue #39): where the fusion project
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
      lines.push("success criteria:", ...brief.successCriteria.map((c) => `- ${c}`));
    }
  }
  const plan = project.plan;
  if (plan !== undefined) {
    lines.push(`plan: ${plan.status} v${plan.version}, ${plan.rows.length} task${plan.rows.length === 1 ? "" : "s"}`);
  }
  if (project.milestones.length > 0) {
    lines.push(`milestones: ${project.milestones.map((m) => `${m.id} (${m.kind}) ${m.state}`).join(", ")}`);
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
      lines.push("next: draft the plan with project.plan, then reply.");
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
      lines.push("next: every milestone is reviewed; the project is complete.");
      break;
    default:
      break;
  }
  return lines.join("\n");
}
