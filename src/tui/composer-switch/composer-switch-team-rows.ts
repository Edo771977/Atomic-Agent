import type { TuiState } from "../tui-state.js";
import type { ComposerSwitchRow } from "./composer-switch-row-contracts.js";

/**
 * The rows of the fusion team pickers (issue #37): the team's directors,
 * or its workers plus a row that drops the chat's preference (each task
 * then runs on its own pick, else the team's default worker). Read from
 * `TuiState.composerTeam`, which the chat orchestrator sets for the open
 * chat right before it opens the picker; empty until then.
 */
export function selectTeamRows(
  state: TuiState,
  role: "director" | "worker",
): readonly ComposerSwitchRow[] {
  const team = state.composerTeam;
  if (team === null) return [];
  if (role === "director") {
    return team.directors.map((member) => ({
      id: `team:director:${member}`,
      label: member,
      detail: "leads this chat: plans, delegates, replies",
      active: team.director === member,
      intent: { kind: "fusionTeamMember" as const, role, member },
    }));
  }
  return [
    ...team.workers.map((member) => ({
      id: `team:worker:${member}`,
      label: member,
      detail: "runs this chat's tasks",
      active: team.worker === member,
      intent: { kind: "fusionTeamMember" as const, role, member },
    })),
    {
      id: "team:worker:none",
      label: "Task's own pick",
      detail: "the director's choice, else the team's default worker",
      active: team.worker === null,
      intent: { kind: "fusionTeamMember" as const, role, member: null },
    },
  ];
}
