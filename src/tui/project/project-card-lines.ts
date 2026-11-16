/**
 * The project card's text (issue #39), as plain lines: pure, so the
 * layout is tested without a terminal and the popup only paints. The
 * card says where an estimate comes from (`measured` from past runs, or
 * `preset`), never presents an unknown cost as zero, and draws the
 * buttons from the view's allowed verdicts.
 */

import type { ProjectGateView } from "../../session/project-gate-view.js";
import type { ProjectMilestone } from "../../session/session-project.js";
import {
  projectCardActions,
  projectCardIsFull,
  projectFieldValue,
  type ProjectCardState,
} from "./project-card-state.js";

export type ProjectLineTone = "title" | "muted" | "warn" | "error" | "ok" | "plain";

export interface ProjectCardSegment {
  text: string;
  tone?: ProjectLineTone;
  inverse?: boolean;
  bold?: boolean;
}

export interface ProjectCardLine {
  segments: ProjectCardSegment[];
}

const line = (text: string, tone: ProjectLineTone = "plain", bold = false): ProjectCardLine => ({ segments: [{ text, tone, bold }] });

export function formatUsd(n: number | null): string {
  if (n === null) return "cost unknown";
  return n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}

export function formatEstMs(ms: number | null): string {
  if (ms === null) return "time unknown";
  const s = Math.round(ms / 1000);
  if (s < 60) return `~${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `~${m}m${s % 60 === 0 ? "" : `${String(s % 60).padStart(2, "0")}s`}`;
  return `~${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** A member ref without its provider, for a narrow column. */
function short(ref: string | null): string {
  if (ref === null) return "no review";
  const i = ref.indexOf(":");
  return i < 0 ? ref : ref.slice(i + 1);
}

function wrap(text: string, width: number): string[] {
  const w = Math.max(10, width);
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let cur = "";
    for (const word of paragraph.split(/\s+/)) {
      if (word.length === 0) continue;
      if (cur.length + word.length + 1 > w && cur.length > 0) {
        out.push(cur);
        cur = word;
      } else cur = cur.length === 0 ? word : `${cur} ${word}`;
    }
    out.push(cur);
  }
  return out;
}

const MILESTONE_MARK: Record<ProjectMilestone["state"], string> = {
  planned: "·", approved: "▸", in_progress: "◐", done: "✓", failed: "✕", reviewed: "✔",
};

export function projectCardTitle(view: ProjectGateView): string {
  switch (view.gate.kind) {
    case "brief":
      return "PROJECT BRIEF — YOUR APPROVAL";
    case "plan":
      return "PROJECT PLAN — YOUR APPROVAL";
    case "milestone": {
      const id = view.gate.id;
      const m = view.milestones.find((x) => x.id === id);
      const state = m?.state === "failed" ? "FAILED" : "DONE";
      return `MILESTONE ${m?.title ?? id} ${state} — YOUR REVIEW`;
    }
    case "none":
      return "PROJECT";
  }
}

export function projectTotalsLine(view: ProjectGateView): string {
  const t = view.totals;
  const unpriced = t.unknownCostRows > 0 ? ` (+${t.unknownCostRows} task${t.unknownCostRows === 1 ? "" : "s"} unpriced)` : "";
  return `${view.rows.length} task${view.rows.length === 1 ? "" : "s"} · ${formatUsd(t.costUsd)}${unpriced} · ${formatEstMs(t.ms)}`;
}

export function projectCardLines(card: ProjectCardState, inner: number): ProjectCardLine[] {
  const view = card.view;
  const full = projectCardIsFull(card) || card.mode === "edit";
  const out: ProjectCardLine[] = [line(` ${projectCardTitle(view)}`, "title", true)];
  const text = (t: string, tone: ProjectLineTone = "plain", indent = 1): void => {
    for (const s of wrap(t, inner - indent - 1)) out.push(line(`${" ".repeat(indent)}${s}`, tone));
  };

  const brief = view.brief;
  if (brief?.draftedAfterUntrusted) {
    text("⚠ This brief was drafted after outside content entered the chat. Read it before approving.", "warn");
  }
  if (brief !== undefined) {
    text(`What: ${brief.what}`);
    if (full || view.gate.kind === "brief") {
      text(`For: ${brief.users}`);
      text(`How: ${brief.how}`);
      if (brief.game) text(`Game: ${brief.game.loop} · ${brief.game.difficulty} · ${brief.game.style}`, "muted");
      if (brief.successCriteria.length > 0) {
        text("Done when:", "muted");
        for (const c of brief.successCriteria) text(`• ${c}`, "plain", 3);
      }
    }
    if (brief.status === "draft" && view.gate.kind !== "brief") text("(brief still a draft)", "muted");
  }

  if (view.rows.length > 0 && view.gate.kind !== "brief") {
    if (full) {
      view.rows.forEach((row, idx) => {
        const focused = card.mode === "edit" && idx === card.row;
        out.push({ segments: [{ text: ` ${focused ? "❯" : " "} ${row.taskId} ${row.title} [${row.milestoneId}]`, bold: focused }] });
        const worker = projectFieldValue(card, idx, "worker");
        const reviewer = projectFieldValue(card, idx, "reviewer");
        const field = (label: string, value: string, which: "worker" | "reviewer"): ProjectCardSegment => ({
          text: `${label} ${value}`,
          inverse: focused && card.field === which,
        });
        out.push({ segments: [
          { text: "     " },
          field("worker", short(worker), "worker"),
          { text: " · " },
          field("review", short(reviewer), "reviewer"),
          { text: ` · ${formatUsd(row.estCostUsd)} · ${formatEstMs(row.estMs)}`, tone: "muted" },
        ] });
        const basis = row.basis === "measured" ? `measured (${row.samples} runs)` : "preset";
        for (const s of wrap(`${basis}: ${row.reason}`, inner - 7)) out.push(line(`       ${s}`, "muted"));
      });
    }
    out.push(line(` Total: ${projectTotalsLine(view)}`, "plain", true));
  }

  for (const v of view.violations) text(`${v.hard ? "✕" : "!"} ${v.message}`, v.hard ? "error" : "warn");

  if (view.milestones.length > 0 && view.gate.kind !== "brief") {
    const gateId = view.gate.kind === "milestone" ? view.gate.id : null;
    const shown = full ? view.milestones : view.milestones.filter((m) => m.id === gateId);
    for (const m of shown) {
      text(`${MILESTONE_MARK[m.state]} ${m.title} (${m.kind}) — ${m.state.replace("_", " ")}`, m.state === "failed" ? "error" : "plain");
      if (m.summary && (full || m.id === gateId)) text(m.summary, "muted", 4);
    }
    if (!full) text(`${view.milestones.length} milestone${view.milestones.length === 1 ? "" : "s"} · /plan shows the full plan`, "muted");
  }

  if (card.error !== null) text(card.error, "error");

  if (card.mode === "note") {
    out.push(line(" Your correction:", "muted"));
    out.push({ segments: [{ text: `  ${card.note}` }, { text: " ", inverse: true }] });
    out.push(line(" enter send · esc back", "muted"));
    return out;
  }
  if (card.mode === "edit") {
    out.push(line(" ↑↓ task · tab worker/review · ←→ pick · enter re-estimate · esc back", "muted"));
    return out;
  }
  const actions = projectCardActions(view);
  const buttons: ProjectCardSegment[] = [{ text: " " }];
  actions.forEach((a, idx) => {
    buttons.push({ text: ` ${a.key} ${a.label} `, inverse: idx === card.cursor, bold: idx === card.cursor });
    buttons.push({ text: " " });
  });
  out.push({ segments: buttons });
  out.push(line(card.pending ? " deciding…" : " ←→ move · enter or letter choose · esc put away (/plan reopens)", "muted"));
  return out;
}

/**
 * The line a chat with a project shows when it is opened (issue #39):
 * what was finished last and what happens next, and the `/fusion
 * resume` offer for a milestone a restart cut off mid-run.
 */
export function projectResumeLine(view: ProjectGateView): string | null {
  const exp = view.expectation;
  if (exp.kind === "cancelled") return null;
  const done = [...view.milestones].reverse().find((m) => m.state === "done" || m.state === "reviewed");
  const title = (id: string): string => view.milestones.find((m) => m.id === id)?.title ?? id;
  let next: string;
  switch (exp.kind) {
    case "draft_brief":
      next = "the director drafts the brief";
      break;
    case "draft_plan":
      next = "the director drafts the plan";
      break;
    case "run_milestone":
      next = title(exp.id);
      break;
    case "complete":
      next = "nothing — every milestone is reviewed";
      break;
    case "await_person":
      next = exp.gate.kind === "milestone"
        ? `your review of ${title(exp.gate.id)} (/plan)`
        : `your approval of the ${exp.gate.kind} (/plan)`;
      break;
  }
  const running = view.milestones.find((m) => m.state === "in_progress");
  const resume = running !== undefined ? ` · ${running.title} was cut off mid-run: /fusion resume continues it` : "";
  return `Project — last done: ${done?.title ?? "nothing yet"} · next: ${next}${resume}`;
}
