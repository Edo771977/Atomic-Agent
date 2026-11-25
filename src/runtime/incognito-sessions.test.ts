import { seedLegacyRetry } from "../tasks/idea-legacy-fixture.js";
import { IdeaStore } from "../tasks/idea-store.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../session/session-store.js";
import { createEmptySessionState, recordTurn } from "../session/session-state.js";
import { userTurn } from "../session/conversation-turn.js";
import type { TurnOwnerProbe } from "../session/turn-owner.js";
import { StructuredLogger, type LogRecord } from "../tracing/structured-logger.js";
import { TaskRunner } from "../tasks/task-runner.js";
import { TaskStore } from "../tasks/task-store.js";
import {
  createIncognitoSessions,
  removeIncognitoTrace,
  sweepOrphanIncognitoSessions,
} from "./incognito-sessions.js";

/** ATO-586: closing an incognito chat deletes its row and trace file. */

function probe(pid: number, alive: Set<number>): TurnOwnerProbe {
  return { pid, host: "darwin", hostUptime: () => 50_000, isAlive: (p) => alive.has(p), processStartOf: () => null };
}

describe("incognito sessions in the runtime", () => {
  let dir: string;
  let tracesDir: string;
  let records: LogRecord[];
  let logger: StructuredLogger;
  const stores: SessionStore[] = [];
  const alive = new Set<number>();

  const open = (pid: number): SessionStore => {
    const store = new SessionStore({ dbFile: join(dir, "sessions.sqlite"), turnOwnerProbe: probe(pid, alive) });
    stores.push(store);
    return store;
  };
  const trace = (id: string): string => join(tracesDir, `${id}.ndjson`);
  const save = (store: SessionStore, id: string, incognito: boolean): void => {
    store.save(recordTurn(
      createEmptySessionState({ id, workingDir: "/w", ...(incognito ? { incognito: store.newIncognitoMark() } : {}) }),
      userTurn("hi"),
    ));
    writeFileSync(trace(id), "{}\n");
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "runtime-incognito-"));
    tracesDir = join(dir, "traces");
    mkdirSync(tracesDir);
    records = [];
    logger = new StructuredLogger({ level: "debug", sinks: [(record) => records.push(record)] });
    alive.clear();
  });

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(["close", "boot"] as const)("purges legacy retry ideas together with private tasks on %s", async (mode) => {
    alive.add(10);
    const store = open(10);
    save(store, "s-secret", true);
    const dbFile = join(dir, "tasks.sqlite");
    const tasks = new TaskStore({ dbFile });
    const ideas = new IdeaStore({ dbFile });
    try {
      const task = tasks.create({ sessionId: "s-secret", userMessage: "PRIVATE-TASK-SECRET", origin: "cli", maxAttempts: 1 });
      const [idea] = ideas.sync([{ kind: "retry_task", sourceKey: "task:" + task.id, title: "private", reason: "fixture",
        evidence: { source: "task", ref: task.id, excerpt: "private", at: null }, prompt: "PRIVATE-TASK-SECRET", sessionId: null }]).added;
      ideas.claimForAccept(idea!.id, null);
      if (mode === "close") {
        expect(createIncognitoSessions({ sessionStore: store, taskStore: tasks, tracesDir, isBusy: () => false, logger }).discard("s-secret")).toBe("deleted");
      } else {
        alive.delete(10);
        await sweepOrphanIncognitoSessions(open(30), tracesDir, logger, dbFile);
      }
      expect(tasks.get(task.id)).toBeNull();
      expect(ideas.list()).toEqual([]);
    } finally { ideas.close(); tasks.close(); }
  });

  it("startup removes legacy Retry cards whose deleted source cannot be proved ordinary", async () => {
    const store = open(30);
    save(store, "ordinary", false);
    const dbFile = join(dir, "tasks.sqlite");
    const tasks = new TaskStore({ dbFile });
    const ideas = new IdeaStore({ dbFile });
    try {
      for (const id of ["missing", "known"]) seedLegacyRetry(dbFile, { kind: "retry_task", sourceKey: "task:" + id,
        title: "fixture", reason: "fixture", evidence: { source: "task" as const, ref: id, excerpt: "fixture", at: null },
        prompt: "PRIVATE-TASK-SECRET", sessionId: id === "known" ? "ordinary" : null });
      await sweepOrphanIncognitoSessions(store, tracesDir, logger, dbFile);
      expect(ideas.list().map((i) => i.sourceKey)).toEqual(["task:known"]);
    } finally { ideas.close(); tasks.close(); }
  });

  it("discard deletes an idle incognito chat and its trace now", () => {
    const store = open(1);
    save(store, "s-secret", true);
    const sessions = createIncognitoSessions({ sessionStore: store, tracesDir, isBusy: () => false, logger });
    expect(sessions.discard("s-secret")).toBe("deleted");
    expect(store.load("s-secret")).toBeNull();
    expect(existsSync(trace("s-secret"))).toBe(false);
  });

  it("discard never deletes an ordinary chat", () => {
    const store = open(1);
    save(store, "s-plain", false);
    const sessions = createIncognitoSessions({ sessionStore: store, tracesDir, isBusy: () => false, logger });
    expect(sessions.discard("s-plain")).toBe("not_incognito");
    expect(sessions.discard("s-never-saved")).toBe("not_incognito");
    expect(store.load("s-plain")).not.toBeNull();
    expect(existsSync(trace("s-plain"))).toBe(true);
  });

  it("waits for a running turn, then deletes once the session is idle", () => {
    const store = open(1);
    save(store, "s-secret", true);
    let busy = true;
    const sessions = createIncognitoSessions({ sessionStore: store, tracesDir, isBusy: () => busy, logger });
    expect(sessions.discard("s-secret")).toBe("deferred");
    expect(store.load("s-secret")).not.toBeNull();
    // Still busy (a turn queued behind): kept.
    sessions.settle("s-secret");
    expect(store.load("s-secret")).not.toBeNull();
    busy = false;
    sessions.settle("s-secret");
    expect(store.load("s-secret")).toBeNull();
    expect(existsSync(trace("s-secret"))).toBe(false);
  });

  it("purges the prompt and run history when closing during a recurring task turn", async () => {
    const store = open(1);
    save(store, "s-secret", true);
    const tasks = new TaskStore({ dbFile: join(dir, "tasks.sqlite") });
    try {
      const closed = tasks.create({ sessionId: "s-secret", userMessage: "private", origin: "cli", maxAttempts: 1 });
      tasks.markRunning(closed.id);
      tasks.markFailed(closed.id, { category: "tool", message: "private failure" });
      const recurring = tasks.create({
        sessionId: "s-secret", userMessage: "private recurring", origin: "cli", maxAttempts: 1,
        schedule: { kind: "interval", everyMs: 60_000 },
      });
      let busy = false;
      const sessions = createIncognitoSessions({ sessionStore: store, tracesDir, isBusy: () => busy, logger, taskStore: tasks });
      const runner = new TaskRunner({
        store: tasks, sessionLoader: store, defaultMaxSteps: 5,
        backoff: { initialMs: 1, maxMs: 10 }, enabled: true, runOnCreate: false,
        runtime: { runTurn: async session => {
          busy = true;
          expect(sessions.discard(session.id)).toBe("deferred");
          busy = false;
          sessions.settle(session.id);
          return { session, reason: "reply", stepCount: 1 };
        } },
      });
      await runner.runOne(recurring.id);
      expect(store.load("s-secret")).toBeNull();
      expect(tasks.get(closed.id)).toBeNull();
      expect(tasks.get(recurring.id)).toBeNull();
      expect(tasks.listRuns(closed.id)).toEqual([]);
      expect(tasks.listRuns(recurring.id)).toEqual([]);
    } finally {
      tasks.close();
    }
  });

  it("settle leaves sessions nobody discarded alone", () => {
    const store = open(1);
    save(store, "s-secret", true);
    const sessions = createIncognitoSessions({ sessionStore: store, tracesDir, isBusy: () => false, logger });
    sessions.settle("s-secret");
    expect(store.load("s-secret")).not.toBeNull();
  });

  it("the boot sweep deletes a dead process's chats with their traces and logs once", async () => {
    alive.add(10).add(20);
    save(open(10), "s-dead", true);
    save(open(20), "s-live", true);
    alive.delete(10);
    const boot = open(30);
    expect((await sweepOrphanIncognitoSessions(boot, tracesDir, logger)).deleted).toEqual(["s-dead"]);
    expect(existsSync(trace("s-dead"))).toBe(false);
    expect(existsSync(trace("s-live"))).toBe(true);
    expect(records.filter((r) => r.message === "deleted incognito chats left by a stopped agent")).toHaveLength(1);
  });

  it("the boot sweep drops the tasks a dead process's incognito chat left (ATO-1547)", async () => {
    alive.add(10).add(20);
    save(open(10), "s-dead", true);
    save(open(20), "s-live", true);
    const tasksDbFile = join(dir, "tasks.sqlite");
    const tasks = new TaskStore({ dbFile: tasksDbFile });
    const task = (sessionId: string): string =>
      tasks.create({ sessionId, userMessage: `secret for ${sessionId}`, origin: "cli", maxAttempts: 1 }).id;
    const dead = task("s-dead");
    const live = task("s-live");
    alive.delete(10);

    expect((await sweepOrphanIncognitoSessions(open(30), tracesDir, logger, tasksDbFile)).deleted).toEqual(["s-dead"]);
    expect(tasks.get(dead)).toBeNull();
    expect(tasks.get(live)).not.toBeNull();
    tasks.close();
  });

  it("purges private tasks at startup after a retryable close failure", async () => {
    alive.add(10);
    const store = open(10);
    save(store, "s-secret", true);
    const tasksDbFile = join(dir, "tasks.sqlite");
    const tasks = new TaskStore({ dbFile: tasksDbFile });
    try {
      const task = tasks.create({ sessionId: "s-secret", userMessage: "private", origin: "cli", maxAttempts: 1 });
      tasks.markRunning(task.id);
      tasks.markFailed(task.id, { category: "tool", message: "private error" });
      vi.spyOn(tasks, "removeForSession").mockImplementationOnce(() => { throw new Error("SQLITE_BUSY"); });
      const sessions = createIncognitoSessions({ sessionStore: store, tracesDir, isBusy: () => false, logger, taskStore: tasks });
      expect(sessions.discard("s-secret")).toBe("failed");
      expect(store.load("s-secret")?.incognito).toBeDefined();
      alive.delete(10);
      const boot = open(30);
      expect(await sweepOrphanIncognitoSessions(boot, tracesDir, logger, tasksDbFile)).toEqual({
        deleted: ["s-secret"], retained: [],
      });
      expect(boot.load("s-secret")).toBeNull();
      expect(existsSync(trace("s-secret"))).toBe(false);
      expect(tasks.get(task.id)).toBeNull();
      expect(tasks.listRuns(task.id)).toEqual([]);
    } finally {
      tasks.close();
    }
  });

  it("retains an orphan chat while a live process owns one of its tasks", async () => {
    alive.add(10).add(20);
    save(open(10), "s-dead", true);
    const tasksDbFile = join(dir, "tasks.sqlite");
    const deadRunner = new TaskStore({ dbFile: tasksDbFile, ownerProbe: probe(10, alive) });
    const liveRunner = new TaskStore({ dbFile: tasksDbFile, ownerProbe: probe(20, alive) });
    const create = (store: TaskStore, text: string): string =>
      store.create({ sessionId: "s-dead", userMessage: text, origin: "cli", maxAttempts: 1 }).id;
    const killed = create(deadRunner, "secret for s-dead");
    expect(deadRunner.markRunning(killed)?.status).toBe("running");
    const held = create(liveRunner, "held by a live runner");
    expect(liveRunner.markRunning(held)?.status).toBe("running");
    deadRunner.close();
    alive.delete(10);

    const boot = open(30);
    const sweep = () => sweepOrphanIncognitoSessions(boot, tracesDir, logger, tasksDbFile, { ownerProbe: probe(30, alive) });
    expect(await sweep()).toEqual({ deleted: [], retained: ["s-dead"] });
    expect(boot.isIncognito("s-dead")).toBe(true);
    expect(liveRunner.get(killed)?.status).toBe("running");
    expect(liveRunner.get(held)?.status).toBe("running");

    alive.delete(20);
    expect(await sweep()).toEqual({ deleted: ["s-dead"], retained: [] });
    expect(boot.isIncognito("s-dead")).toBe(false);
    expect(liveRunner.get(killed)).toBeNull();
    expect(liveRunner.get(held)).toBeNull();
    liveRunner.close();
  });

  it("blocks later claims by a live runner that saved someone else's orphan chat", async () => {
    alive.add(10).add(20);
    save(open(10), "s-dead", true);
    const runnerSessions = open(20);
    const dbFile = join(dir, "tasks.sqlite");
    const tasks = new TaskStore({
      dbFile, ownerProbe: probe(20, alive),
      skipSession: id => runnerSessions.isOrphanIncognito(id),
    });
    try {
      const create = (scheduled = false) => tasks.create({
        sessionId: "s-dead", userMessage: "private", origin: "cli", maxAttempts: 1,
        ...(scheduled ? { schedule: { kind: "interval" as const, everyMs: 60_000 } } : {}),
      });
      const held = create(true);
      const pending = create();
      expect(tasks.markRunning(held.id)?.status).toBe("running");
      runnerSessions.save(runnerSessions.load("s-dead")!);
      alive.delete(10);
      expect(await sweepOrphanIncognitoSessions(open(30), tracesDir, logger, dbFile, {
        ownerProbe: probe(30, alive),
      })).toEqual({ deleted: [], retained: ["s-dead"] });
      expect(tasks.listDue(Date.now() + 120_000)).toEqual([]);
      expect(tasks.markRunning(pending.id)).toBeNull();
      expect(tasks.get(held.id)?.status).toBe("running");
      const now = Date.now();
      expect(tasks.markInterrupted(held.id, { nextScheduledFor: now + 60_000 }, now)?.status).toBe("pending");
      expect(tasks.listDue(now + 120_000)).toEqual([]);
      expect(tasks.markRunning(held.id, now + 120_000)).toBeNull();
    } finally {
      tasks.close();
    }
  });

  it("rejects an old incognito mark with the same PID and no process start token", () => {
    alive.add(20);
    const prior = open(20);
    save(prior, "s-old", true);
    const current = open(20);
    save(current, "s-current", true);
    expect(current.isOrphanIncognito("s-current")).toBe(false);
    // Loading and saving a previous process's row must not adopt its mark.
    current.save(current.load("s-old")!);
    expect(current.isOrphanIncognito("s-old")).toBe(true);
    current.save(current.load("s-current")!);
    expect(current.isOrphanIncognito("s-current")).toBe(false);
  });

  it("erases run history for purged private tasks and keeps ordinary history", async () => {
    alive.add(10);
    save(open(10), "s-dead", true);
    const dbFile = join(dir, "tasks.sqlite");
    const tasks = new TaskStore({ dbFile, ownerProbe: probe(10, alive) });
    const privateTask = tasks.create({ sessionId: "s-dead", userMessage: "private", origin: "cli", maxAttempts: 1 });
    const ordinaryTask = tasks.create({ sessionId: "s-plain", userMessage: "ordinary", origin: "cli", maxAttempts: 1 });
    tasks.markRunning(privateTask.id);
    tasks.markRunning(ordinaryTask.id);
    expect(tasks.listRuns(privateTask.id)).toHaveLength(1);
    alive.delete(10);

    await sweepOrphanIncognitoSessions(open(30), tracesDir, logger, dbFile, { ownerProbe: probe(30, alive) });
    expect(tasks.get(privateTask.id)).toBeNull();
    expect(tasks.listRuns(privateTask.id)).toEqual([]);
    expect(tasks.listRuns(ordinaryTask.id)).toHaveLength(1);
    tasks.close();
  });

  it("keeps a chat whose tasks could not be dropped, for the next start", async () => {
    alive.add(10);
    save(open(10), "s-dead", true);
    alive.delete(10);
    // A directory where the tasks file should be: it cannot be opened.
    const tasksDbFile = join(dir, "tasks-dir");
    mkdirSync(tasksDbFile);
    const boot = open(30);

    expect(await sweepOrphanIncognitoSessions(boot, tracesDir, logger, tasksDbFile)).toEqual({ deleted: [], retained: ["s-dead"] });
    expect(boot.isIncognito("s-dead")).toBe(true);
    expect(existsSync(trace("s-dead"))).toBe(true);
    expect(records.some((r) => r.level === "warn" && r.context?.sessionId === "s-dead")).toBe(true);
  });

  it("a sweep with no tasks file still deletes the chat", async () => {
    alive.add(10);
    save(open(10), "s-dead", true);
    alive.delete(10);
    expect((await sweepOrphanIncognitoSessions(open(30), tracesDir, logger, join(dir, "missing.sqlite"))).deleted).toEqual(["s-dead"]);
    expect(existsSync(join(dir, "missing.sqlite"))).toBe(false);
  });

  it("a failing sweep is logged and never throws", async () => {
    const failing = { sweepOrphanIncognito: async (): Promise<string[]> => { throw new Error("locked"); } };
    expect((await sweepOrphanIncognitoSessions(failing, tracesDir, logger)).deleted).toEqual([]);
    expect(records.some((r) => r.level === "warn" && r.context?.error === "locked")).toBe(true);
  });

  it("never removes a file outside the traces folder", () => {
    const outside = join(dir, "keep.ndjson");
    writeFileSync(outside, "{}\n");
    // Issue #74: the id maps to a safe name inside the folder; the file outside stays.
    removeIncognitoTrace(tracesDir, "../keep");
    expect(existsSync(outside)).toBe(true);
    expect(removeIncognitoTrace(null, "s-any")).toBe(false);
  });
  it("an incognito turn marks the launch's prompt cache private; an ordinary one does not", () => {
    const store = open(1);
    const marks: number[] = [];
    const sessions = createIncognitoSessions({
      sessionStore: store, tracesDir, isBusy: () => false, logger,
      promptCache: { markPrivate: () => { marks.push(1); }, eraseSlots: () => {} },
    });
    sessions.noteTurn(createEmptySessionState({ id: "s-plain", workingDir: "/w" }));
    expect(marks).toHaveLength(0);
    sessions.noteTurn(createEmptySessionState({ id: "s-secret", workingDir: "/w", incognito: store.newIncognitoMark() }));
    expect(marks).toHaveLength(1);
  });

  it("says an incognito chat is open from its first turn until it is closed: error reports hold (#29)", () => {
    const store = open(1);
    save(store, "s-secret", true);
    const sessions = createIncognitoSessions({ sessionStore: store, tracesDir, isBusy: () => false, logger });
    expect(sessions.anyOpen()).toBe(false);
    sessions.noteTurn(createEmptySessionState({ id: "s-plain", workingDir: "/w" }));
    expect(sessions.anyOpen()).toBe(false);
    sessions.noteTurn({ ...store.load("s-secret")!, id: "s-secret" });
    expect(sessions.anyOpen()).toBe(true);
    expect(sessions.discard("s-secret")).toBe("deleted");
    expect(sessions.anyOpen()).toBe(false);
  });

  it("closing an incognito chat erases the slots that held its prompt", async () => {
    const store = open(1);
    save(store, "s-secret", true);
    save(store, "s-plain", false);
    const erased: number[][] = [];
    const sessions = createIncognitoSessions({
      sessionStore: store, tracesDir, isBusy: () => false, logger,
      slotsOf: (id) => (id === "s-secret" ? [1, 3] : [0]),
      promptCache: { markPrivate: () => {}, eraseSlots: async (ids) => { erased.push([...ids]); } },
    });
    expect(sessions.discard("s-plain")).toBe("not_incognito");
    expect(erased).toEqual([]);
    expect(sessions.discard("s-secret")).toBe("deleted");
    expect(erased).toEqual([[1, 3]]);
  });

  it("a failing erase never fails the close", async () => {
    const store = open(1);
    save(store, "s-secret", true);
    const sessions = createIncognitoSessions({
      sessionStore: store, tracesDir, isBusy: () => false, logger,
      slotsOf: () => [0],
      promptCache: { markPrivate: () => { throw new Error("disk"); }, eraseSlots: () => Promise.reject(new Error("down")) },
    });
    expect(() => sessions.noteTurn(store.load("s-secret")!)).not.toThrow();
    expect(sessions.discard("s-secret")).toBe("deleted");
    await new Promise((r) => setTimeout(r, 0));
  });
  it("closing an incognito chat deletes its fusion run checkpoints; an ordinary chat keeps them", () => {
    const store = open(1);
    save(store, "s-secret", true);
    save(store, "s-plain", false);
    const removed: string[] = [];
    const sessions = createIncognitoSessions({
      sessionStore: store, tracesDir, isBusy: () => false, logger,
      fusionRuns: { removeForSession: (id) => { removed.push(id); return 1; } },
    });
    sessions.discard("s-plain");
    expect(sessions.discard("s-secret")).toBe("deleted");
    expect(removed).toEqual(["s-secret"]);
  });

  it("the boot sweep deletes a dead incognito chat's fusion run checkpoints", async () => {
    alive.add(10);
    save(open(10), "s-dead", true);
    alive.delete(10);
    const removed: string[] = [];
    expect((await sweepOrphanIncognitoSessions(open(30), tracesDir, logger, undefined, {}, (id) => { removed.push(id); })).deleted).toEqual(["s-dead"]);
    expect(removed).toEqual(["s-dead"]);
  });
  it("a fusion worker of an incognito chat is incognito too, even before the chat's first save", () => {
    const store = open(1);
    const sessions = createIncognitoSessions({ sessionStore: store, tracesDir, isBusy: () => false, logger });
    const worker = (parent: string) =>
      sessions.forWorker(parent, createEmptySessionState({ id: `s-w-${parent}`, workingDir: "/w" }));
    // Never saved: known from the turn it is running.
    sessions.noteTurn(createEmptySessionState({ id: "s-fresh", workingDir: "/w", incognito: store.newIncognitoMark() }));
    expect(worker("s-fresh").incognito).toBeDefined();
    save(store, "s-saved", true);
    expect(worker("s-saved").incognito).toBeDefined();
    save(store, "s-plain", false);
    expect(worker("s-plain").incognito).toBeUndefined();
    // Closed: its later workers (none should exist) are not marked from memory.
    expect(sessions.discard("s-saved")).toBe("deleted");
    expect(worker("s-saved").incognito).toBeUndefined();
  });
});
