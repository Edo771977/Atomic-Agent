import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stateDirProjectRecords } from "../../session/project-decisions.js";
import { projectFilePath } from "../../session/project-store.js";
import { createSessionProjectStore } from "../../session/session-project-store.js";
import { applyProjectUpdate } from "../../session/session-project.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { createRuntimeProject } from "./runtime-project.js";

export function fixtureBacklogRuntime(sessionId: string) {
  const folder = mkdtempSync(join(tmpdir(), "aa-backlog-"));
  const stateDir = join(folder, "state");
  const cleanup = () => rmSync(folder, { recursive: true, force: true });
  try {
    const store = createSessionProjectStore({ stateDir, records: stateDirProjectRecords(stateDir) });
    const draft = applyProjectUpdate(undefined, {
      kind: "brief",
      brief: { what: "Notes app", users: "Me", how: "Node", successCriteria: ["Stores notes"] },
      draftedAfterUntrusted: false,
    }, 1);
    if (!draft.ok) throw new Error(draft.error.message);
    const added = applyProjectUpdate(draft.project, {
      kind: "backlog_add", item: { id: "b1", title: "Dark theme", source: "director" },
    }, 2);
    if (!added.ok) throw new Error(added.error.message);
    const created = store.commit(createEmptySessionState({ id: sessionId, workingDir: folder }), added.project);
    if (!created.ok) throw new Error(created.problem.message);
    let session = created.session;
    const runtime = createRuntimeProject({
      loadSession: (id) => id === sessionId ? store.load(session) : null,
      saveSession: (saved) => { session = saved; },
      projectStore: store,
      isBusy: () => false,
      liveInputs: () => ({
        plan: {
          workers: [], reviewers: [], defaultWorker: null, reviewerFor: () => null,
          reviewOn: false, records: [], pricing: () => undefined, tokensPerSecond: () => null,
          minSamples: 3, days: 30,
        },
        constraints: { isLocal: () => true }, strength: () => null, isLocal: () => true,
      }),
      emit: () => {},
    });
    return {
      runtime,
      cleanup,
      renameItem(title: string) {
        const file = projectFilePath(folder);
        const json = JSON.parse(readFileSync(file, "utf8"));
        json.project.backlog[0].title = title;
        writeFileSync(file, JSON.stringify(json));
      },
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
