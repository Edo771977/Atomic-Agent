import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../session/session-store.js";
import { createEmptySessionState, recordTurn } from "../session/session-state.js";
import { userTurn } from "../session/conversation-turn.js";
import type { TurnOwnerProbe } from "../session/turn-owner.js";
import { StructuredLogger, type LogRecord } from "../tracing/structured-logger.js";
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

  it("settle leaves sessions nobody discarded alone", () => {
    const store = open(1);
    save(store, "s-secret", true);
    const sessions = createIncognitoSessions({ sessionStore: store, tracesDir, isBusy: () => false, logger });
    sessions.settle("s-secret");
    expect(store.load("s-secret")).not.toBeNull();
  });

  it("the boot sweep deletes a dead process's chats with their traces and logs once", () => {
    alive.add(10).add(20);
    save(open(10), "s-dead", true);
    save(open(20), "s-live", true);
    alive.delete(10);
    const boot = open(30);
    expect(sweepOrphanIncognitoSessions(boot, tracesDir, logger)).toEqual(["s-dead"]);
    expect(existsSync(trace("s-dead"))).toBe(false);
    expect(existsSync(trace("s-live"))).toBe(true);
    expect(records.filter((r) => r.message === "deleted incognito chats left by a stopped agent")).toHaveLength(1);
  });

  it("the boot sweep drops the tasks a dead process's incognito chat left (ATO-1547)", () => {
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

    expect(sweepOrphanIncognitoSessions(open(30), tracesDir, logger, tasksDbFile)).toEqual(["s-dead"]);
    expect(tasks.get(dead)).toBeNull();
    expect(tasks.get(live)).not.toBeNull();
    tasks.close();
  });

  it("keeps a chat whose tasks could not be dropped, for the next start", () => {
    alive.add(10);
    save(open(10), "s-dead", true);
    alive.delete(10);
    // A directory where the tasks file should be: it cannot be opened.
    const tasksDbFile = join(dir, "tasks-dir");
    mkdirSync(tasksDbFile);
    const boot = open(30);

    expect(sweepOrphanIncognitoSessions(boot, tracesDir, logger, tasksDbFile)).toEqual([]);
    expect(boot.isIncognito("s-dead")).toBe(true);
    expect(existsSync(trace("s-dead"))).toBe(true);
    expect(records.some((r) => r.level === "warn" && r.message.includes("tasks of an incognito chat"))).toBe(true);
  });

  it("a sweep with no tasks file still deletes the chat", () => {
    alive.add(10);
    save(open(10), "s-dead", true);
    alive.delete(10);
    expect(sweepOrphanIncognitoSessions(open(30), tracesDir, logger, join(dir, "missing.sqlite"))).toEqual(["s-dead"]);
    expect(existsSync(join(dir, "missing.sqlite"))).toBe(false);
  });

  it("a failing sweep is logged and never throws", () => {
    const failing = { sweepOrphanIncognito: (): string[] => { throw new Error("locked"); } };
    expect(sweepOrphanIncognitoSessions(failing, tracesDir, logger)).toEqual([]);
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

  it("the boot sweep deletes a dead incognito chat's fusion run checkpoints", () => {
    alive.add(10);
    save(open(10), "s-dead", true);
    alive.delete(10);
    const removed: string[] = [];
    expect(sweepOrphanIncognitoSessions(open(30), tracesDir, logger, undefined, { removeForSession: (id) => { removed.push(id); return 1; } })).toEqual(["s-dead"]);
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
