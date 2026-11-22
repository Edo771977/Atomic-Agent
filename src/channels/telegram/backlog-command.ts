import { createHash } from "node:crypto";

import { visiblePreviewLine } from "../../approval/approval-preview.js";
import type { AgentRuntime } from "../../runtime/runtime-contract.js";
import { backlogDecisionFingerprint, type ProjectBacklogDecision } from "../../session/project-backlog.js";
import { normalizeCriterionId } from "../../session/project-criterion-id.js";
import type { ProjectGateBacklog, ProjectGateView } from "../../session/project-gate-view.js";

const TARGET_STATE = { "/promote": "promoted", "/drop": "dropped", "/reopen": "open" } as const satisfies
  Record<string, ProjectBacklogDecision["state"]>;

type PlanBacklogCommand = "/defer" | "/activate";

export type BacklogCommand = "/backlog" | keyof typeof TARGET_STATE | PlanBacklogCommand;

interface BacklogCommandDeps {
  runtime: Pick<AgentRuntime, "projectState" | "projectBacklogDecision" | "projectDecision">;
  sessionId: string | null;
  chatKey: string;
  busy: boolean;
}

function visible(text: string): string {
  return visiblePreviewLine(text.replace(/[\\\n\u2028\u2029]/g, (char) => {
    if (char === "\\") return "\\\\";
    if (char === "\n") return "\\n";
    return `\\u${char.charCodeAt(0).toString(16)}`;
  }));
}

function itemLine(item: ProjectGateBacklog["items"][number]): string {
  const adoption = item.state !== "promoted"
    ? ""
    : item.plannedIn === undefined ? ", not in any plan" : `, taken in by plan v${item.plannedIn}`;
  const deferred = item.deferred === true ? ", deferred" : "";
  return `${visible(item.id)} — ${visible(item.title)} [${item.state}${deferred}${adoption}]` +
    (item.condition === undefined ? "" : `\n  Seed condition: ${visible(item.condition)}`);
}

function staleLine(call: ProjectGateBacklog["stale"][number]): string {
  const detail = call.reason === "removed" ? "item removed outside Atomic Agent" : "item changed and is open again";
  return `${visible(call.id)} — stale ${call.state} decision (${detail}).`;
}

function renderBacklog(backlog: ProjectGateBacklog | undefined): string {
  if (backlog === undefined || (backlog.items.length === 0 && backlog.stale.length === 0)) {
    return "The project backlog is empty.";
  }
  return [
    "Project backlog",
    ...backlog.items.map(itemLine),
    ...backlog.stale.map(staleLine),
    "Use /promote <id>, /drop <id> or /reopen <id> to preview a decision.",
    "At the plan gate, use /defer <id> or /activate <id> to preview a change for a promoted item waiting for the plan.",
  ].join("\n");
}

function confirmationCode(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

function itemFingerprint(
  item: ProjectGateBacklog["items"][number] | undefined,
  stale: ProjectGateBacklog["stale"][number] | undefined,
): string {
  return item?.fingerprint ?? stale?.fingerprint ?? backlogDecisionFingerprint(item, item?.state, item?.plannedIn, stale);
}

function runPlanBacklogCommand(
  command: PlanBacklogCommand,
  id: string,
  confirmation: string | undefined,
  view: ProjectGateView,
  deps: BacklogCommandDeps & { sessionId: string },
): string {
  const { version, gate, backlog } = view;
  if (gate.kind !== "plan" || version === null || !view.allowedVerdicts.includes("edit")) {
    return "Change a promoted backlog item's status while a plan waits for your approval. Reply /plan to see the current gate.";
  }
  if (deps.runtime.projectDecision === undefined) return "This agent takes no project decisions.";
  const promoted = backlog?.promoted.find((entry) => entry.id === id);
  const item = backlog?.items.find((entry) => entry.id === id);
  if (promoted?.citedBy === undefined || item === undefined) {
    return `Backlog item ${id} must be promoted and listed with task citations in the current plan view. Reply /backlog to see the items.`;
  }
  const status = command === "/defer" ? "deferred" : "active";
  const currentStatus = promoted.deferred === true ? "deferred" : "active";
  const stale = backlog?.stale.find((entry) => entry.id === id);
  const code = confirmationCode([
    deps.chatKey, deps.sessionId, command, id, itemFingerprint(item, stale), version, currentStatus, promoted.citedBy,
  ]);
  if (confirmation !== undefined && confirmation !== code) {
    return `Confirmation no longer matches. Preview the decision again with ${command} ${id}.`;
  }
  if (status === currentStatus) return `Backlog item ${id} is already ${status}.`;
  if (confirmation === undefined) {
    const action = status === "deferred" ? "Make this item optional for this plan" : "Require this item in the plan again";
    const citations = promoted.citedBy.length === 0 ? "none" : promoted.citedBy.map(visible).join(", ");
    return [
      itemLine(item),
      ...(item.note === undefined ? [] : [`  Note: ${visible(item.note)}`]),
      `Plan v${version}. Tasks citing this item: ${citations}.`,
      `${action}. To confirm, reply ${command} ${id} ${code}.`,
    ].join("\n");
  }
  const result = deps.runtime.projectDecision(deps.sessionId, {
    gate, version, verdict: "edit", edits: { backlogStatus: { [id]: status } },
  });
  if (!result.ok) return `Backlog unchanged. ${visible(result.error.message)}`;
  return `Updated backlog. ${id} is now ${status}.`;
}

/** The inbound handler enforces owner, chat and egress rules before calling this. */
export function runBacklogCommand(command: BacklogCommand, args: readonly string[], deps: BacklogCommandDeps): string {
  const { sessionId, runtime, busy, chatKey } = deps;
  if (command === "/backlog" && args.length !== 0) return "Usage: /backlog";
  const view = sessionId === null ? null : runtime.projectState?.(sessionId) ?? null;
  if (view === null || sessionId === null) return "This chat has no project record.";
  if (command === "/backlog") return renderBacklog(view.backlog);
  if (busy) return "Wait for the current turn to finish, then decide.";
  if (view.cancelled) return "The project was cancelled. Its backlog decisions are closed.";

  const [rawId, confirmation] = args;
  const id = normalizeCriterionId(rawId);
  if (id === null || args.length > 2 || (confirmation !== undefined && !/^[0-9a-f]{16}$/.test(confirmation))) {
    return `Usage: ${command} <id> [confirmation-code]. Reply /backlog to see the item IDs.`;
  }
  if (command === "/defer" || command === "/activate") {
    return runPlanBacklogCommand(command, id, confirmation, view, { ...deps, sessionId });
  }
  if (runtime.projectBacklogDecision === undefined) return "This agent takes no backlog decisions.";
  const state = TARGET_STATE[command];
  const item = view.backlog?.items.find((candidate) => candidate.id === id);
  const stale = view.backlog?.stale.find((candidate) => candidate.id === id);
  if (item === undefined && !(state === "open" && stale?.reason === "removed")) {
    return `The backlog has no item ${id}. Reply /backlog to see the items.`;
  }
  if (item?.state === state && stale === undefined) return `Backlog item ${id} is already ${state}.`;
  const expectedFingerprint = itemFingerprint(item, stale);
  const code = confirmationCode([chatKey, sessionId, command, id, expectedFingerprint]);

  if (confirmation === undefined) {
    const action = command === "/promote" ? "Propose for the next plan" : command === "/drop" ? "Drop this item" : "Clear the previous backlog decision";
    return [
      ...(item === undefined ? [] : [itemLine(item)]),
      ...(item?.note === undefined ? [] : [`  Note: ${visible(item.note)}`]),
      ...(stale === undefined ? [] : [staleLine(stale)]),
      `${action}. To confirm, reply ${command} ${id} ${code}.`,
    ].join("\n");
  }
  if (confirmation !== code) return `Confirmation no longer matches. Preview the decision again with ${command} ${id}.`;
  const result = runtime.projectBacklogDecision(sessionId, { id, state, expectedFingerprint });
  if (!result.ok) return `Backlog unchanged. ${visible(result.error.message)}`;
  return item === undefined ? `Updated backlog. Cleared the previous decision for ${id}.` : `Updated backlog. ${id} is now ${state}.`;
}
