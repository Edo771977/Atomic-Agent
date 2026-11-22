import { openProject } from "../src/session/project-store.js";
import { stateDirProjectRecords } from "../src/session/project-decisions.js";
import { sameProjectFolder } from "../src/session/project-folder.js";
import { readProjectRef } from "../src/session/session-project-store.js";

export { runVerify } from "../src/tools/verify/run-verify.js";
export { candidateWorkerRuns } from "../src/tools/fusion/candidate-outcomes.js";
export { sameProjectFolder };

/** New sessions keep a reference; old runs embed the project in the session row. */
export function readRecordedProject(payload: Record<string, unknown>, cwd: string, stateDir: string): {
  project?: unknown;
  error?: string;
} {
  const reference = readProjectRef({ projectRef: payload.projectRef });
  if (!reference) {
    return payload.projectRef === undefined
      ? { project: payload.project }
      : { error: "the session's project reference is invalid" };
  }
  if (!sameProjectFolder(cwd, reference.folder)) {
    return { error: "the project reference points outside the selected working directory" };
  }
  const opened = openProject(reference.folder, { stateDir, records: stateDirProjectRecords(stateDir) });
  if (!opened.ok) return { error: opened.problem.message };
  if (opened.opened.stored.id !== reference.id || opened.opened.decisionSeq === 0) {
    return { error: "the session's recorded project identity or decision record could not be verified" };
  }
  return { project: opened.opened.project };
}
