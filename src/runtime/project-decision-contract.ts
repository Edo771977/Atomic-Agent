import type { ProjectDecisionError, ProjectState } from "../session/session-project.js";
import type { ProjectGateView } from "../tools/fusion/project-gate-view.js";

/**
 * What `runtime.projectDecision` returns (issue #39): the project's own
 * refusals (`applyProjectDecision`) plus the runtime's. Implemented in
 * `composition/runtime-project.ts`.
 */
export type RuntimeProjectDecisionError =
  | ProjectDecisionError
  | { code: "turn-running"; message: string }
  | { code: "no-session"; message: string };

export type RuntimeProjectDecisionResult =
  | { ok: true; project: ProjectState; view: ProjectGateView }
  | { ok: false; error: RuntimeProjectDecisionError };
