import type { ResumableFusionRun } from "../runtime/runtime-contract.js";
import { formatRelativeMs } from "./tasks/tasks-summary.js";

/**
 * The one-line offers for fusion runs a restart cut off (ATO-617).
 *
 * Shown, never acted on: a resume may run workers again, and those cost
 * time and money, so it is always the person's `/fusion resume`.
 */

/** On opening a session: its own unfinished run, if any. */
export function formatSessionFusionNotice(
  runs: readonly ResumableFusionRun[],
): string | null {
  const newest = runs[0];
  if (newest === undefined) return null;
  const more =
    runs.length > 1 ? ` (${runs.length - 1} older one${runs.length === 2 ? "" : "s"} too: /fusion lists them)` : "";
  return `${capitalise(newest.summary)}${more}. /fusion resume continues from the unfinished wave · /fusion discard drops it`;
}

/** How many cut-off runs the start-up notice describes one by one. */
const STARTUP_RUNS_SHOWN = 3;

/**
 * At start-up, before any session is opened: which work was cut off. Each
 * run (newest first, at most three) says its folder, the start of the
 * request, when it started and how many tasks are done and left, so the
 * person knows what `/fusion resume` would continue before opening it.
 * The runs of `currentSessionId` are left to the session notice.
 */
export function formatStartupFusionNotice(
  runs: readonly ResumableFusionRun[],
  currentSessionId: string | null,
  now: number = Date.now(),
): string | null {
  const elsewhere = runs.filter((run) => run.sessionId !== currentSessionId);
  if (elsewhere.length === 0) return null;
  const head = `${elsewhere.length} Fusion run${elsewhere.length === 1 ? " was" : "s were"} cut off before finishing:`;
  const lines = elsewhere.slice(0, STARTUP_RUNS_SHOWN).map((run) => `  · ${describeRunForStartup(run, now)}`);
  const more = elsewhere.length - STARTUP_RUNS_SHOWN;
  if (more > 0) lines.push(`  · and ${more} more (/fusion lists a session's runs)`);
  const tail = elsewhere.length === 1
    ? "Open its session from /sessions and type /fusion resume to continue, or /fusion discard to drop it."
    : "Open a session from /sessions and type /fusion resume to continue its run, or /fusion discard to drop it.";
  return [head, ...lines, tail].join("\n");
}

function describeRunForStartup(run: ResumableFusionRun, now: number): string {
  const parts: string[] = [run.workingDir ?? `session ${run.sessionId}`];
  if (run.request) parts.push(`"${run.request}"`);
  if (run.startedAt !== undefined) parts.push(`started ${formatRelativeMs(run.startedAt, now)}`);
  if (run.tasksDone !== undefined && run.tasksLeft !== undefined) {
    parts.push(`${run.tasksDone} task${run.tasksDone === 1 ? "" : "s"} done, ${run.tasksLeft} left`);
  } else {
    parts.push(run.summary);
  }
  return `${parts.join(" — ")} (session ${run.sessionId})`;
}

function capitalise(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}
