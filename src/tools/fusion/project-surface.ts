import { PROJECT_TOOL_NAMES } from "./project-tools.js";

/**
 * Which sessions get the fusion project flow (issue #39): the
 * `project.*` tools and the `### fusion` block's project lines. The flow
 * stops at gates only a person decides, so it is offered only where a
 * surface draws the gate and takes the decision:
 *   - the TUI (`tui`) and the headless CLI (`cli`, also a turn that names
 *     no origin): the card, `run --approve <version>`;
 *   - Telegram (`telegram`): `/plan approve <version>`;
 *   - a client that declares it (`projectGates: true`): an HTTP
 *     extensions client sending `X-Atomic-Project: 1`, a sidecar host
 *     whose `start_session` declares `capabilities.project`.
 * Off everywhere else (the desktop until its card ships, a plain OpenAI
 * client, Discord, scheduled tasks, fusion workers): the session would
 * stop at a gate nobody can open. There the fan-out asks as it did
 * before projects.
 *
 * Decided once per session (`metadata.projectGates`, stamped by the
 * runtime on its first turn), never per turn: the tools and guidance are
 * stable-prefix bytes. Takes plain strings so `src/tools` does not import
 * from `src/runtime`.
 */
export function surfaceShowsProjectGates(input: {
  origin?: string;
  answerChannel?: string;
  /** The client declared (true) or refused (false) the project flow. */
  projectGates?: boolean;
}): boolean {
  if (input.projectGates !== undefined) return input.projectGates;
  if (input.answerChannel === "desktop") return false;
  switch (input.origin ?? "cli") {
    case "tui":
    case "cli":
    case "telegram":
      return true;
    default:
      return false;
  }
}

const PROJECT_TOOLS: ReadonlySet<string> = new Set(PROJECT_TOOL_NAMES);

/**
 * The turn's tool filter with the project tools hidden when the session
 * has no project gates. With gates the caller's filter comes back
 * untouched (`undefined` stays `undefined`).
 */
export function withProjectToolVisibility(
  filter: ((name: string) => boolean) | undefined,
  projectGates: boolean,
): ((name: string) => boolean) | undefined {
  if (projectGates) return filter;
  return filter
    ? (name) => !PROJECT_TOOLS.has(name) && filter(name)
    : (name) => !PROJECT_TOOLS.has(name);
}
