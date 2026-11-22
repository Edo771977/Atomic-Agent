import { createHash } from "node:crypto";

import { visiblePreviewLine } from "../../approval/approval-preview.js";
import type { AgentRuntime } from "../../runtime/runtime-contract.js";
import { backlogDecisionFingerprint, type ProjectBacklogDecision } from "../../session/project-backlog.js";
import { normalizeCriterionId } from "../../session/project-criterion-id.js";
import type { ProjectGateBacklog } from "../../session/project-gate-view.js";

const TARGET_STATE = { "/promote": "promoted", "/drop": "dropped", "/reopen": "open" } as const satisfies
  Record<string, ProjectBacklogDecision["state"]>;

export type BacklogCommand = "/backlog" | keyof typeof TARGET_STATE;

interface BacklogCommandDeps {
  runtime: Pick<AgentRuntime, "projectState" | "projectBacklogDecision">;
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
  return `${visible(item.id)} — ${visible(item.title)} [${item.state}${adoption}]` +
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
  ].join("\n");
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
  if (runtime.projectBacklogDecision === undefined) return "This agent takes no backlog decisions.";

  const [rawId, confirmation] = args;
  const id = normalizeCriterionId(rawId);
  if (id === null || args.length > 2 || (confirmation !== undefined && !/^[0-9a-f]{16}$/.test(confirmation))) {
    return `Usage: ${command} <id> [confirmation-code]. Reply /backlog to see the item IDs.`;
  }
  const state = TARGET_STATE[command];
  const item = view.backlog?.items.find((candidate) => candidate.id === id);
  const stale = view.backlog?.stale.find((candidate) => candidate.id === id);
  if (item === undefined && !(state === "open" && stale?.reason === "removed")) {
    return `The backlog has no item ${id}. Reply /backlog to see the items.`;
  }
  if (item?.state === state && stale === undefined) return `Backlog item ${id} is already ${state}.`;
  const expectedFingerprint = backlogDecisionFingerprint(item, item?.state, item?.plannedIn, stale);
  const code = createHash("sha256")
    .update(JSON.stringify([chatKey, sessionId, command, id, expectedFingerprint]))
    .digest("hex").slice(0, 16);

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
