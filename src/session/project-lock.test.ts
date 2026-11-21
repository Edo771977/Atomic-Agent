/**
 * Issue #109 review: the project store's lock file.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withFileLock } from "./project-lock.js";

let dir: string;
let lock: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aa-lock-"));
  lock = join(dir, "project.json.lock");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("project lock (issue #109 review)", () => {
  it("records its owner and removes only its own lock", () => {
    const seen = withFileLock(lock, () => JSON.parse(readFileSync(lock, "utf8")) as { pid: number; at: number; token: string }, { waitMs: 50 });
    expect(seen).toMatchObject({ ok: true, value: { pid: process.pid } });
    expect(existsSync(lock)).toBe(false);
    const kept = withFileLock(lock, () => {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), token: "someone-else" }));
      return 1;
    }, { waitMs: 50 });
    expect(kept).toEqual({ ok: true, value: 1 });
    expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe("someone-else");
  });

  it("a live holder keeps it: the second waiter is told the store is locked", () => {
    const inner = withFileLock(lock, () => withFileLock(lock, () => "ran", { waitMs: 30 }), { waitMs: 30 });
    expect(inner).toEqual({ ok: true, value: { ok: false, locked: true } });
  });

  it("takes over a lock whose time is in the future, whose owner is gone, or that is old", () => {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() + 3_600_000, token: "future" }));
    expect(withFileLock(lock, () => "future taken", { waitMs: 30 })).toEqual({ ok: true, value: "future taken" });
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now(), token: "gone", host: "same" }));
    expect(withFileLock(lock, () => "dead taken", { waitMs: 30, host: "same" })).toEqual({ ok: true, value: "dead taken" });
    writeFileSync(lock, "garbage");
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(lock, old, old);
    expect(withFileLock(lock, () => "old taken", { waitMs: 30 })).toEqual({ ok: true, value: "old taken" });
    writeFileSync(lock, "garbage");
    const future = (Date.now() + 3_600_000) / 1000;
    utimesSync(lock, future, future);
    expect(withFileLock(lock, () => "future mtime taken", { waitMs: 30 })).toEqual({ ok: true, value: "future mtime taken" });
  });
});

describe("the store's lock (issue #109 review)", () => {
  it("a lock file left with a future time does not lock the project forever", async () => {
    const { stateDirProjectRecords } = await import("./project-decisions.js");
    const { createProject, commitProject, projectStoreDir } = await import("./project-store.js");
    const stateDir = join(dir, "state");
    const folder = join(dir, "folder");
    const options = { stateDir, records: stateDirProjectRecords(stateDir) };
    const created = createProject(folder, { milestones: [], gate: { kind: "none" } }, options);
    if (!created.ok) throw new Error(created.problem.message);
    const stuck = join(projectStoreDir(folder), "project.json.lock");
    writeFileSync(stuck, "");
    const future = (Date.now() + 3_600_000) / 1000;
    utimesSync(stuck, future, future);
    const w = commitProject(folder, created.opened.stored.id, { revision: 1, decisionSeq: created.opened.decisionSeq }, { milestones: [], gate: { kind: "none" }, versionFloor: 3 }, options);
    expect(w.ok).toBe(true);
  });
});
