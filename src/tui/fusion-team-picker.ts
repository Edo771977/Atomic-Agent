import type { UserLlmRunModeConfig } from "../config/llm-run-mode-config.js";
import { teamMembers } from "../llm/run-mode/fusion-team.js";
import { sessionDirectorChoice } from "../runtime/session-director.js";
import { readSessionFusionDirector, readSessionFusionWorker } from "../session/session-fusion-team.js";
import type { ComposerTeamState } from "./composer-switch/composer-switch-state.js";

/**
 * What the TUI's fusion team pickers show for the open chat (issue #37),
 * and whether its first submit must ask for a director. Pure: the chat
 * orchestrator passes the live run-mode block, the chat's metadata and
 * which providers can serve (`usable`, the registry's providers).
 */

/** The pickers' rows for this chat; null without a team. */
export function teamPickerState(
  runMode: UserLlmRunModeConfig | undefined,
  metadata: Record<string, unknown> | undefined,
  usable: (providerId: string) => boolean,
): ComposerTeamState | null {
  const team = runMode?.fusion?.team;
  if (team === undefined) return null;
  const refs = (role: "directors" | "workers"): string[] =>
    teamMembers(team, role).filter((m) => usable(m.providerId)).map((m) => m.ref);
  return {
    directors: refs("directors"),
    workers: refs("workers"),
    director: readSessionFusionDirector(metadata)?.member ?? null,
    worker: readSessionFusionWorker(metadata)?.member ?? null,
  };
}

/**
 * The first submit of a fusion chat asks for its director when the team
 * offers several usable ones and the chat has none: the runtime would
 * otherwise pick the default on its own. One usable director is picked
 * by the runtime, which says so.
 */
export function needsDirectorPick(
  runMode: UserLlmRunModeConfig | undefined,
  metadata: Record<string, unknown> | undefined,
  usable: (providerId: string) => boolean,
): boolean {
  if (runMode?.mode !== "fusion") return false;
  return sessionDirectorChoice(metadata, runMode.fusion, undefined, (m) => usable(m.providerId))?.reason === "default";
}
