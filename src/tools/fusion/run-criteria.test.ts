import { mkdirSync, mkdtempSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requireSymlinks } from "../../test-symlink-support.js";
import { milestoneShotsDir, PROJECT_LIMITS } from "../../session/session-project.js";
import { FUSION_RUNS_DIR_NAME } from "./run-checkpoint.js";
import { readMilestoneEvidence, writeRunChangedFiles, writeRunCriteriaFacts } from "./run-criteria.js";

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

  it("combines delivered paths across runs without changing criterion evidence", () => {
    const state = stateDir();
    const runsDir = runsOf(state);
    const r1 = { runId: "fr-1", sessionId: "s" };
    writeRunChangedFiles(runsDir, r1, ["src/a.ts", "package.json"]);
    writeRunCriteriaFacts(runsDir, r1, [{ taskId: "a", facts: [{ id: "c1", state: "passed" }] }]);
    writeRunChangedFiles(runsDir, r1, ["src/a.ts", "src/b.ts"]);
    writeRunChangedFiles(runsDir, { ...r1, runId: "fr-2" }, ["src/b.ts", "README.md"]);
    const evidence = readMilestoneEvidence({ runsDir, stateDir: state, runIds: ["fr-1", "fr-2"], criteriaOrder: ["c1"] });
    expect(evidence.changedFiles).toEqual(["README.md", "package.json", "src/a.ts", "src/b.ts"]);
    expect(evidence.facts).toEqual([{ id: "c1", state: "passed" }]);
  });

  it("keeps bounded change evidence and flags an untracked shared run", () => {
    const state = stateDir();
    const runsDir = runsOf(state);
    const run = { runId: "fr-1", sessionId: "s" };
    writeRunChangedFiles(runsDir, run, [], true);
    writeRunChangedFiles(runsDir, { ...run, runId: "fr-2" },
      Array.from({ length: 2000 }, (_, i) => `src/${i}-${"a".repeat(250)}.ts`));
    const input = { runsDir, stateDir: state, criteriaOrder: [] };
    expect(readMilestoneEvidence({ ...input, runIds: ["fr-1"] })).toMatchObject({ changedFilesIncomplete: true });
    const large = readMilestoneEvidence({ ...input, runIds: ["fr-2"] });
    expect(large.changedFilesIncomplete).toBe(true);
    expect(large.changedFiles!.length).toBeLessThan(2000);
    expect(large.changedFiles!.length).toBeGreaterThan(1);
  });

  it("keeps the weakest basis across tasks without changing the criterion verdict", () => {
    const state = stateDir();
    writeRunCriteriaFacts(runsOf(state), { runId: "fr-1", sessionId: "s" }, [
      { taskId: "rules", facts: [{ id: "c1", state: "passed", why: "check wins tie", basis: { kind: "check", checks: [{ index: 1 }] } }] },
      { taskId: "board", facts: [{ id: "c1", state: "passed", basis: { kind: "vision", model: "cloud:vision" } }] },
    ]);
    const out = readMilestoneEvidence({ runsDir: runsOf(state), stateDir: state, runIds: ["fr-1"], criteriaOrder: ORDER });
    expect(out.facts).toEqual([{ id: "c1", state: "passed", why: "check wins tie", basis: { kind: "vision", model: "cloud:vision" } }]);
  });

  it("keeps the model behind the winning verdict when multiple tasks used vision", () => {
    const state = stateDir();
    writeRunCriteriaFacts(runsOf(state), { runId: "fr-1", sessionId: "s" }, [
      { taskId: "board", facts: [{ id: "c1", state: "passed", basis: { kind: "vision", model: "cloud:board" } }] },
      { taskId: "rules", facts: [{ id: "c1", state: "failed", basis: { kind: "vision", model: "cloud:rules" } }] },
    ]);
    const out = readMilestoneEvidence({ runsDir: runsOf(state), stateDir: state, runIds: ["fr-1"], criteriaOrder: ORDER });
    expect(out.facts).toEqual([{ id: "c1", state: "failed", basis: { kind: "vision", model: "cloud:rules" } }]);
  });

  it("takes the newest run's fact per criterion, whichever task carried it (worst within one run)", () => {
    const state = stateDir();
    // An older run's task red on c1; a newer run fixed c1 under another task id.
    writeRunCriteriaFacts(runsOf(state), { runId: "fr-1", sessionId: "s" }, [
      { taskId: "board", facts: [{ id: "c1", state: "failed", why: "old" }] },
    ]);
    writeRunCriteriaFacts(runsOf(state), { runId: "fr-2", sessionId: "s" }, [
      { taskId: "board-fix", facts: [{ id: "c1", state: "passed", why: "fixed" }] },
      { taskId: "rules", facts: [{ id: "c2", state: "passed", why: "ok" }] },
      { taskId: "rules-ui", facts: [{ id: "c2", state: "unverified", why: "no vision judge" }] },
    ]);
    const out = readMilestoneEvidence({ runsDir: runsOf(state), stateDir: state, runIds: ["fr-1", "fr-2"], criteriaOrder: ORDER });
    expect(out.facts).toEqual([
      { id: "c1", state: "passed", why: "fixed" },
      { id: "c2", state: "unverified", why: "no vision judge" },
    ]);
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

  it("attaches a task's screenshots from its newest run only, not from the attempts before it", () => {
    const state = stateDir();
    const shoot = (runId: string, names: string[], at: number) => {
      const dir = milestoneShotsDir(state, runId);
      mkdirSync(dir, { recursive: true });
      names.forEach((name, i) => {
        const path = join(dir, name);
        writeFileSync(path, "x");
        utimesSync(path, at + i, at + i);
      });
      return dir;
    };
    // Three attempts at ciao-html (each run numbers its shots from 1), one at rules.
    shoot("fr-1", ["ciao-html-1.jpg", "ciao-html-2.jpg"], 1_000);
    const rules = shoot("fr-2", ["rules-1.jpg"], 2_000);
    shoot("fr-2", ["ciao-html-1.jpg"], 2_100);
    const last = shoot("fr-3", ["ciao-html-1.jpg", "ciao-html-2.jpg"], 3_000);
    const out = readMilestoneEvidence({ runsDir: runsOf(state), stateDir: state, runIds: ["fr-1", "fr-2", "fr-3"], criteriaOrder: ORDER });
    expect(out.attachments.map((a) => a.path)).toEqual([
      join(last, "ciao-html-2.jpg"),
      join(last, "ciao-html-1.jpg"),
      join(rules, "rules-1.jpg"),
    ]);
    expect(new Set(out.attachments.map((a) => a.caption)).size).toBe(out.attachments.length);
  });

  it("does not attach a symlink in the shots folder", (context) => {
    requireSymlinks(context);
    const state = stateDir();
    const shots = milestoneShotsDir(state, "fr-1");
    mkdirSync(shots, { recursive: true });
    const outside = join(state, "secret.jpg");
    writeFileSync(outside, "x");
    symlinkSync(outside, join(shots, "board-1.jpg"));
    writeFileSync(join(shots, "board-2.jpg"), "x");
    const out = readMilestoneEvidence({ runsDir: runsOf(state), stateDir: state, runIds: ["fr-1"], criteriaOrder: ORDER });
    expect(out.attachments.map((a) => a.path)).toEqual([join(shots, "board-2.jpg")]);
  });

  it("reads nothing from a run id that could leave the folder or a malformed file", () => {
    const state = stateDir();
    mkdirSync(join(runsOf(state), "fr-bad"), { recursive: true });
    writeFileSync(join(runsOf(state), "fr-bad", "criteria.json"), "{not json");
    const out = readMilestoneEvidence({ runsDir: runsOf(state), stateDir: state, runIds: ["../x", "fr-bad"], criteriaOrder: ORDER });
    expect(out).toEqual({ facts: [], attachments: [], uncovered: ORDER });
  });
});
