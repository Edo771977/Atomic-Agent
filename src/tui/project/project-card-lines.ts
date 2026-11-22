/**
 * The project card's text (issue #39), as plain lines: pure, so the
 * layout is tested without a terminal and the popup only paints. The
 * card says where an estimate comes from (`measured` from past runs, or
 * `preset`), never presents an unknown cost as zero, and draws the
 * buttons from the view's allowed verdicts.
 */

import { pathToFileURL } from "node:url";

import { PLAN_UNTRUSTED_WARNING, PROJECT_WRITE_SCOPE_NOTE, attachmentLabel, criterionBasisSummaryLine, criterionFactLine, decisionLine, directorReportWarningLine, seedHint, summarizeCriterionBases } from "../../session/project-gate-text.js";
import type { ProjectGateView } from "../../session/project-gate-view.js";
import type { ProjectMilestone } from "../../session/session-project.js";
import {
  backlogIds,
  projectBacklogActions,
  projectCardActions,
  projectCardIsFull,
  projectFieldValue,
  type ProjectCardState,
} from "./project-card-state.js";

function evidenceVerifyHint(folder: string | undefined): string {
  const command = "Run atomic-agent project verify";
  if (folder === undefined) return command;
  // Keep unusual paths as a quoted display value, away from shell syntax.
  if (/[\x00-\x1f\x7f-\x9f"$%!`]/.test(folder) || folder.endsWith("\\")) {
    return command + " for folder " + JSON.stringify(folder).replace(/[\x7f-\x9f]/g, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
  }
  return command + ' "' + folder + '"';
}

export type ProjectLineTone = "title" | "muted" | "warn" | "error" | "ok" | "plain";

export interface ProjectCardSegment {
  text: string;
  tone?: ProjectLineTone;
  inverse?: boolean;
  bold?: boolean;
  /** A file or web URL the popup draws the text as (OSC 8): a picture's path. */
  link?: string;
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

/** A path as a file URL; undefined when it cannot be one. */
function fileLink(path: string): string | undefined {
  try {
    return pathToFileURL(path).href;
  } catch {
    return undefined;
  }
}

const MILESTONE_KIND_LABEL: Partial<Record<ProjectMilestone["kind"], string>> = {
  draft: "Draft",
  review: "Review",
  final: "Final",
};

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
  const rows = view.plan?.rows ?? [];
  const t = view.plan?.totals ?? { costUsd: null, ms: null, unknownCostRows: 0 };
  const unpriced = t.unknownCostRows > 0 ? ` (+${t.unknownCostRows} task${t.unknownCostRows === 1 ? "" : "s"} unpriced)` : "";
  return `${rows.length} task${rows.length === 1 ? "" : "s"} · ${formatUsd(t.costUsd)}${unpriced} · ${formatEstMs(t.ms)}`;
}

export function projectCardLines(card: ProjectCardState, inner: number): ProjectCardLine[] {
  const view = card.view;
  const full = projectCardIsFull(card) || card.mode === "edit";
  const out: ProjectCardLine[] = [line(` ${projectCardTitle(view)}`, "title", true)];
  const text = (t: string, tone: ProjectLineTone = "plain", indent = 1): void => {
    for (const s of wrap(t, inner - indent - 1)) out.push(line(`${" ".repeat(indent)}${s}`, tone));
  };

  if (card.mode === "backlog") {
    const backlog = view.backlog;
    const ids = backlogIds(view);
    for (const id of ids) {
      const item = backlog?.items.find(entry => entry.id === id);
      const stale = backlog?.stale.find(entry => entry.id === id);
      const selected = id === card.backlogId;
      const label = item ? `${id} ${item.title} · ${item.state}` : id;
      for (const [index, part] of wrap(label, inner - 3).entries()) {
        out.push({ segments: [{ text: `${selected && index === 0 ? "›" : " "} ${part}`, inverse: selected, bold: selected }] });
      }
      if (stale) text(stale.reason === "removed" ? "removed outside Atomic Agent" : `changed since you ${stale.state} it`, "warn", 3);
      if (selected && item?.note) text(item.note, "plain", 3);
      if (selected && item?.condition) text(`When: ${item.condition}`, "plain", 3);
    }
    const actions = projectBacklogActions(card).map(action => `${action.key} ${action.label}`);
    out.push(line(card.error ?? (card.pending ? "Deciding…" : card.backlogNotice || (ids.length ? "↑↓ select an item" : "Backlog is empty.")),
      card.error ? "error" : "muted"));
    out.push(line(" " + [...actions, "esc back"].join(" · "), "muted"));
    return out;
  }

  const brief = view.brief;
  if (brief?.draftedAfterUntrusted) {
    text("⚠ This brief was drafted after outside content entered the chat. Read it before approving.", "warn");
  }
  if (view.gate.kind !== "brief" && view.plan?.draftedAfterUntrusted) {
    text(PLAN_UNTRUSTED_WARNING, "warn");
  }
  if (brief !== null) {
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
  // Issue #112: the brief's decisions, with the person's status and the tasks citing each.
  if ((view.decisions ?? []).length > 0) {
    text("Decisions:", "muted");
    for (const d of view.decisions!) text(`• ${decisionLine(d)}`, d.status === "active" && d.citedBy.length === 0 && view.gate.kind === "plan" ? "warn" : "plain", 3);
  }

  const rows = view.plan?.rows ?? [];
  if (rows.length > 0 && view.gate.kind !== "brief") {
    if (full) {
      rows.forEach((row, idx) => {
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
          { text: ` · ${row.local === true ? "$0.00 (local)" : formatUsd(row.estCostUsd)} · ${formatEstMs(row.estMs)}`, tone: "muted" },
        ] });
        const basis = row.basis === "measured" ? `measured (${row.samples} runs)` : "preset";
        for (const s of wrap(`${basis}: ${row.reason}`, inner - 7)) out.push(line(`       ${s}`, "muted"));
      });
    }
    out.push(line(` Total: ${projectTotalsLine(view)}`, "plain", true));
    if (view.gate.kind === "plan") text(PROJECT_WRITE_SCOPE_NOTE, "muted");
  }

  for (const v of view.violations) text(`${v.severity === "hard" ? "✕" : "!"} ${v.message}`, v.severity === "hard" ? "error" : "warn");
  // Issue #111: the backlog's count; its seeds with their condition where a plan or milestone waits.
  const backlog = view.backlog;
  if (backlog !== undefined) {
    const parts = [`${backlog.open} open`, ...(backlog.seeds.length === 0 ? [] : [`${backlog.seeds.length} seed${backlog.seeds.length === 1 ? "" : "s"}`]), ...(backlog.promoted.length === 0 ? [] : [`${backlog.promoted.length} promoted`])];
    text(`Backlog: ${parts.join(" · ")}`, "muted");
    if (view.gate.kind === "plan" || view.gate.kind === "milestone") {
      for (const s of backlog.seeds) text(`seed ${s.id} ${s.title} — ${s.condition}`, "plain", 3);
    }
    // Issue #146: at the plan gate, each promoted item with the tasks that take it in.
    if (view.gate.kind === "plan") {
      for (const b of backlog.promoted) {
        const cited = b.citedBy ?? [];
        const state = b.deferred === true ? "deferred" : `cited by ${cited.length === 0 ? "no task" : cited.join(", ")}`;
        text(`promoted ${b.id} ${b.title} (${state})`, b.deferred !== true && cited.length === 0 ? "warn" : "plain", 3);
      }
    }
  }
  // The seeds' own hints are drawn above from the structured backlog; every other hint stays.
  const seedHints = new Set((backlog?.seeds ?? []).map((s) => seedHint(s.id, s.title, s.condition)));
  for (const hint of view.hints ?? []) if (!seedHints.has(hint)) text(`ℹ ${hint}`, "muted");

  if (view.milestones.length > 0 && view.gate.kind !== "brief") {
    const gateId = view.gate.kind === "milestone" ? view.gate.id : null;
    const shown = full ? view.milestones : view.milestones.filter((m) => m.id === gateId);
    for (const m of shown) {
      text(`${MILESTONE_MARK[m.state]} ${m.title} (${MILESTONE_KIND_LABEL[m.kind] ?? m.kind}) — ${m.state.replace("_", " ")}`, m.state === "failed" ? "error" : "plain");
      if (full || m.id === gateId) {
        if (m.summary) text(`Director report: ${m.summary}`, "muted", 4);
        for (const note of m.reportNotes ?? []) text(note, "muted", 4);
        const evidence = m.evidenceReceipts;
        if (evidence !== undefined) {
          const { folder, valid, unsigned, problems, partial, archiveUnavailable } = evidence;
          const details: string[] = [];
          if (valid) details.push(`${valid} signed`);
          if (unsigned) details.push(`${unsigned} unsigned (not verifiable; the signing key may have been unavailable)`);
          if (problems) details.push(`${problems} problem${problems === 1 ? "" : "s"}`);
          if (partial) details.push("partial scan");
          if (archiveUnavailable) details.push("archive unavailable");
          const tone = problems || archiveUnavailable ? "error" : unsigned || partial ? "warn" : "ok";
          text(`Evidence: ${details.join(", ")}`, tone, 4);
          if (unsigned || problems || partial || archiveUnavailable) text(evidenceVerifyHint(folder), tone, 4);
        }
        // Evidence of the result (issue #40): never a claim the view does not carry.
        for (const warning of m.directorReportWarnings ?? []) text(directorReportWarningLine(warning), "warn", 4);
        const facts = m.criteriaFacts ?? [];
        if (facts.length > 0) text(criterionBasisSummaryLine(m.criteriaBasisSummary ?? summarizeCriterionBases(facts)), "plain", 4);
        for (const f of facts) {
          text(criterionFactLine(f, brief?.criteria), f.state === "passed" && f.reservation === undefined ? "ok" : f.state === "failed" ? "error" : "warn", 4);
        }
        for (const a of m.attachments ?? []) {
          text(`▣ ${attachmentLabel(a)}`, "plain", 4);
          out.push({ segments: [{ text: "      " }, { text: a.path, tone: "muted", link: fileLink(a.path) }] });
        }
      }
    }
    if (!full) text(`${view.milestones.length} milestone${view.milestones.length === 1 ? "" : "s"} · /plan shows the full plan`, "muted");
  }

  if (card.error !== null) text(card.error, "error");

  if (card.mode === "note") {
    out.push(line(card.noteFor === "approveOverReview" ? " Why approve over the open review:" : " Your correction:", "muted"));
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
  const backlogHint = backlogIds(view).length ? " b Backlog ·" : "";
  out.push(line(card.pending ? " deciding…" : backlogHint + " ←→ move · enter or letter choose · esc put away (/plan reopens)", "muted"));
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
  const open = view.backlog?.open ?? 0;
  return `Project — last done: ${done?.title ?? "nothing yet"} · next: ${next}${resume}${open === 0 ? "" : ` · backlog: ${open} open`}`;
}
