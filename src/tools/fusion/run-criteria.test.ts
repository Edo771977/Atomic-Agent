import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { milestoneShotsDir, PROJECT_LIMITS } from "../../session/session-project.js";
import { FUSION_RUNS_DIR_NAME } from "./run-checkpoint.js";
import { readMilestoneEvidence, writeRunCriteriaFacts } from "./run-criteria.js";

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "run-criteria-"));
}
const runsOf = (state: string) => join(state, FUSION_RUNS_DIR_NAME);
const ORDER = ["c1", "c2", "c3"];

describe("a run's criteria facts and a milestone's evidence (issue #40)", () => {
  it("keeps each run's task facts with the run, private, and folds a milestone's runs: newest run per task, worst state per criterion", () => {
    const state = stateDir();
    writeRunCriteriaFacts(runsOf(state), { runId: "fr-1", sessionId: "s" }, [
      { taskId: "board", facts: [{ id: "c1", state: "failed", why: "check 1 failed" }] },
      { taskId: "rules", facts: [{ id: "c2", state: "passed", why: "ok" }] },
    ]);
    writeRunCriteriaFacts(runsOf(state), { runId: "fr-2", sessionId: "s" }, [
      { taskId: "board", facts: [{ id: "c1", state: "passed", why: "ok" }, { id: "c2", state: "unverified", why: "no vision judge" }] },
    ]);
    if (process.platform !== "win32") expect(statSync(join(runsOf(state), "fr-1", "criteria.json")).mode & 0o777).toBe(0o600);
    const out = readMilestoneEvidence({ runsDir: runsOf(state), stateDir: state, runIds: ["fr-1", "fr-2", "fr-missing"], criteriaOrder: ORDER });
    expect(out.facts).toEqual([
      { id: "c1", state: "passed", why: "ok" },
      { id: "c2", state: "unverified", why: "no vision judge" },
    ]);
    expect(out.uncovered).toEqual(["c3"]);
  });

  it("offers the runs' screenshots as attachments, newest first, at most the cap, captioned and tied to the task's criteria", () => {
    const state = stateDir();
    writeRunCriteriaFacts(runsOf(state), { runId: "fr-1", sessionId: "s" }, [{ taskId: "board", facts: [{ id: "c1", state: "passed", why: "ok" }] }]);
    const shots = milestoneShotsDir(state, "fr-1");
    mkdirSync(shots, { recursive: true });
    for (let i = 1; i <= 10; i += 1) {
      const path = join(shots, `board-${i}.jpg`);
      writeFileSync(path, "x");
      utimesSync(path, 1_000 + i, 1_000 + i);
    }
    writeFileSync(join(shots, "notes.txt"), "not a picture");
    const out = readMilestoneEvidence({ runsDir: runsOf(state), stateDir: state, runIds: ["fr-1"], criteriaOrder: ORDER });
    expect(out.attachments).toHaveLength(PROJECT_LIMITS.attachments);
    expect(out.attachments[0]).toEqual({ path: join(shots, "board-10.jpg"), caption: "board: screenshot 10", criteria: ["c1"] });
    expect(out.attachments.every((a) => a.path.endsWith(".jpg"))).toBe(true);
  });

  it("reads nothing from a run id that could leave the folder or a malformed file", () => {
    const state = stateDir();
    mkdirSync(join(runsOf(state), "fr-bad"), { recursive: true });
    writeFileSync(join(runsOf(state), "fr-bad", "criteria.json"), "{not json");
    const out = readMilestoneEvidence({ runsDir: runsOf(state), stateDir: state, runIds: ["../x", "fr-bad"], criteriaOrder: ORDER });
    expect(out).toEqual({ facts: [], attachments: [], uncovered: ORDER });
  });
});
