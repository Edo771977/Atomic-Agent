import type { ProjectDecisionError, ProjectState } from "../session/session-project.js";
import type { ProjectGateView } from "../session/project-gate-view.js";

/* The caller supplies this separately from the decision sent by a frontend. */
export type ProjectDecisionActor = "person" | "auto-approve";

/**
 * What `runtime.projectDecision` returns (issue #39): the project's own
 * refusals (`applyProjectDecision`) plus the runtime's. Implemented in
 * `composition/runtime-project.ts`.
 */
export type RuntimeProjectDecisionError =
  | ProjectDecisionError
  | { code: "turn-running"; message: string }
  | { code: "no-session"; message: string }
  /** Issue #109: another chat decided this gate at this version first. */
  | { code: "already-decided"; message: string }
  /** Issue #109: the project's folder store refused (damaged, unsupported, changed since read, locked). */
  | { code: "project-store"; message: string };

export type RuntimeProjectDecisionResult =
  | { ok: true; project: ProjectState; view: ProjectGateView }
  | { ok: false; error: RuntimeProjectDecisionError };
