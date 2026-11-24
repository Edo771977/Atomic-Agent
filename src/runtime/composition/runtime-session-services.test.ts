import { createRuntimeTaskStores } from "./runtime-task-services.js";
import { traceFilePath } from "../../tracing/trace/trace-sink.js";
import { privacyVaultFor, forgetPrivacyVault } from "../../privacy/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configuration from "../../config/index.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import * as sessions from "../../session/index.js";
import { ToolOutputSpill } from "../../tools/tool-output-spill.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { userTurn } from "../../session/conversation-turn.js";
import { recordTurn } from "../../session/session-state.js";
import { SessionStore } from "../../session/session-store.js";
import { StructuredLogger, type LogRecord } from "../../tracing/structured-logger.js";
import { TaskStore } from "../../tasks/task-store.js";
import { FileCheckpointStore } from "../../tools/os/fs/fs-checkpoint-store.js";
import { createRuntimeSessionFactories, installRuntimeSessionDelete, prepareRuntimeSessionStore } from "./runtime-session-services.js";

describe("runtime session phases", () => {
  let dir: string;
  let config: AtomicAgentConfig;
  let logger: StructuredLogger;
  let records: LogRecord[];
  const stores: SessionStore[] = [];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-runtime-sessions-"));
    config = configuration.loadConfig();
    config.paths.stateDir = dir;
    config.paths.sessionsDbFile = join(dir, "sessions.sqlite");
    config.paths.tasksDbFile = join(dir, "tasks.sqlite");
    config.paths.tracesDir = join(dir, "traces");
    config.sessions.retention.enabled = false;
    records = [];
    logger = new StructuredLogger({ level: "debug", sinks: [record => records.push(record)] });
    vi.spyOn(configuration, "getConfig").mockReturnValue(config);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const store of stores.splice(0)) store.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function open() { const store = await prepareRuntimeSessionStore(config, logger); stores.push(store); return store; }

  it("forgets the vault when a regular or incognito chat is deleted", async () => {
    const store = await open();
    installRuntimeSessionDelete(store, vi.fn(), { endSession: vi.fn() });
    for (const incognito of [false, true]) {
      const id = incognito ? "privacy-incognito" : "privacy-regular";
      const session = sessions.createEmptySessionState({
        id, workingDir: dir, ...(incognito ? { incognito: store.newIncognitoMark() } : {}),
      });
      try {
        expect(privacyVaultFor(id)).not.toBe(privacyVaultFor("another-chat"));
        expect(privacyVaultFor(id).mask("archive-only@example.test")).toBe("[EMAIL_1]");
        store.save(recordTurn(session, userTurn("Transcript text")));
        const transcript = JSON.stringify(store.load(id));
        expect(transcript).toContain("Transcript text");
        expect(transcript).not.toContain("archive-only@example.test");
        expect(transcript).not.toContain("[EMAIL_1]");
        store.delete(id);
        expect(store.load(id)).toBeNull();
        expect(privacyVaultFor(id).unmask("[EMAIL_1]")).toBe("[EMAIL_1]");
      } finally {
        forgetPrivacyVault(id);
      }
    }
  });

  it("the boot sweep drops the tasks of the incognito chats it deletes (ATO-586)", async () => {
    const tasks = new TaskStore({ dbFile: config.paths.tasksDbFile });
    tasks.create({ sessionId: "s-dead", userMessage: "secret follow-up", origin: "http", maxAttempts: 1 });
    tasks.create({ sessionId: "s-plain", userMessage: "ordinary", origin: "http", maxAttempts: 1 });
    tasks.close();
    vi.spyOn(SessionStore.prototype, "sweepOrphanIncognito").mockImplementation(async (beforeDelete) => { await beforeDelete?.("s-dead"); return ["s-dead"]; });
    await open();
    const after = new TaskStore({ dbFile: config.paths.tasksDbFile });
    try {
      expect(after.list().map((t) => t.sessionId)).toEqual(["s-plain"]);
    } finally { after.close(); }
  });

  it("removes an orphan incognito chat's file checkpoints and tool output during startup", async () => {
    const checkpoints = new FileCheckpointStore(join(dir, "file-checkpoints"));
    const spill = new ToolOutputSpill({ baseDir: join(dir, "spill") });
    const seeded = new SessionStore({ dbFile: config.paths.sessionsDbFile });
    try {
      // A stored mark with our PID is treated as belonging to an earlier
      // process at boot, before this runtime has opened any chats.
      seeded.save(recordTurn(sessions.createEmptySessionState({
        id: "s-dead", workingDir: dir, incognito: seeded.newIncognitoMark(),
      }), userTurn("private")));
      seeded.save(recordTurn(sessions.createEmptySessionState({
        id: "s-kept", workingDir: dir,
      }), userTurn("ordinary")));
    } finally {
      seeded.close();
    }
    const file = join(dir, "private.txt");
    await writeFile(file, "private");
    const output = compressToolResult({ tool: "os.shell.run", status: "ok", output: "log line\n".repeat(5000) });
    for (const id of ["s-dead", "s-kept"]) {
      await checkpoints.capture(id, file, "os.fs.write");
      await spill.spill("os.shell.run", id, output);
      expect(existsSync(spill.dirFor(id))).toBe(true);
    }

    const store = await prepareRuntimeSessionStore(config, logger, checkpoints, spill);
    stores.push(store);

    expect(store.load("s-dead")).toBeNull();
    expect(store.load("s-kept")?.id).toBe("s-kept");
    await vi.waitFor(() => expect(existsSync(checkpoints.sessionDir("s-dead"))).toBe(false));
    expect(existsSync(spill.dirFor("s-dead"))).toBe(false);
    expect(existsSync(checkpoints.sessionDir("s-kept"))).toBe(true);
    expect(existsSync(spill.dirFor("s-kept"))).toBe(true);
  });

  it("deletes the private row and trace despite a checkpoint failure and retries on the next boot", async () => {
    const checkpoints = new FileCheckpointStore(join(dir, "file-checkpoints"));
    const file = join(dir, "private.txt");
    await writeFile(file, "private");
    await checkpoints.capture("s-dead", file, "os.fs.write");
    const seeded = new SessionStore({ dbFile: config.paths.sessionsDbFile });
    seeded.save(recordTurn(sessions.createEmptySessionState({
      id: "s-dead", workingDir: dir, incognito: seeded.newIncognitoMark(),
    }), userTurn("private")));
    seeded.close();

    await mkdir(config.paths.tracesDir, { recursive: true });
    const trace = traceFilePath(config.paths.tracesDir, "s-dead");
    await writeFile(trace, "private trace");
    const remove = vi.spyOn(checkpoints, "removeSession").mockRejectedValue(new Error("checkpoint busy"));
    const first = await prepareRuntimeSessionStore(config, logger, checkpoints);
    stores.push(first);
    expect(first.load("s-dead")).toBeNull();
    expect(existsSync(trace)).toBe(false);
    expect(existsSync(checkpoints.sessionDir("s-dead"))).toBe(true);
    expect(records.some(record => record.context?.error === "checkpoint busy")).toBe(true);

    remove.mockRestore();
    const second = await prepareRuntimeSessionStore(config, logger, new FileCheckpointStore(join(dir, "file-checkpoints")));
    stores.push(second);
    expect(second.load("s-dead")).toBeNull();
    expect(existsSync(checkpoints.sessionDir("s-dead"))).toBe(false);
  });

  it("keeps a task out of the due queue and refuses its claim when orphan task cleanup fails", async () => {
    const seeded = new SessionStore({ dbFile: config.paths.sessionsDbFile });
    seeded.save(sessions.createEmptySessionState({
      id: "s-dead", workingDir: dir, incognito: seeded.newIncognitoMark(),
    }));
    seeded.close();
    const tasks = new TaskStore({ dbFile: config.paths.tasksDbFile });
    const pending = tasks.create({ sessionId: "s-dead", userMessage: "private", origin: "cli", maxAttempts: 1 });
    const running = tasks.create({ sessionId: "s-dead", userMessage: "private", origin: "cli", maxAttempts: 1 });
    tasks.markRunning(running.id);
    tasks.close();
    vi.spyOn(TaskStore.prototype, "removeForSessionAtBoot").mockImplementationOnce(() => { throw new Error("busy"); });

    let retained: readonly string[] = [];
    const sessionStore = await prepareRuntimeSessionStore(config, logger, undefined, undefined, ids => { retained = ids; });
    stores.push(sessionStore);
    const { taskStore } = createRuntimeTaskStores({ config, logger, sessionStore, retainedIncognitoIds: retained });
    try {
      expect(taskStore.listDue(Date.now())).toEqual([]);
      expect(taskStore.get(running.id)?.status).toBe("running");
      expect(taskStore.markRunning(pending.id)).toBeNull();
      expect(taskStore.get(pending.id)?.status).toBe("pending");
    } finally {
      taskStore.close();
    }
  });

  it("recovers before retention reads pins and passes the existing pin sources", async () => {
    config.sessions.retention.enabled = true;
    const events: string[] = [];
    vi.spyOn(SessionStore.prototype, "recoverInterruptedTurns").mockImplementation(() => { events.push("recover"); return ["old"]; });
    const pins = vi.spyOn(sessions, "readSessionPins").mockImplementation(() => { events.push("pins"); return ["keep"]; });
    vi.spyOn(sessions, "pruneSessions").mockImplementation(options => {
      events.push("prune"); expect(options.keepSessionIds).toEqual(["keep"]);
      return { deleted: 0, orphans: 0, unreadable: 0, tracesRemoved: 0, vacuumed: false };
    });
    await open();
    expect(events).toEqual(["recover", "pins", "prune"]);
    expect(pins).toHaveBeenCalledWith({ tasksDbFile: config.paths.tasksDbFile, webhookSessionsFile: join(dir, "webhook-sessions.json") });
    expect(records.map(record => record.message)).toContain("sessions left mid-turn by a stopped agent marked cancelled");
    expect(records.some(record => record.message === "pruned sessions past retention")).toBe(false);
  });

  it("recovery and retention failures are separately logged and preserve the opened store", async () => {
    config.sessions.retention.enabled = true;
    vi.spyOn(SessionStore.prototype, "recoverInterruptedTurns").mockImplementation(() => { throw new Error("recovery failed"); });
    vi.spyOn(sessions, "readSessionPins").mockImplementation(() => { throw new Error("pins failed"); });
    const store = await open();
    expect(records.filter(record => record.level === "warn").map(record => record.context?.error)).toEqual(["recovery failed", "pins failed"]);
    const state = sessions.createEmptySessionState({ id: "survived", workingDir: dir });
    store.save(state);
    expect(store.load(state.id)?.id).toBe(state.id);
  });

  it("skips the prune and says so when a pin file cannot be read", async () => {
    config.sessions.retention.enabled = true;
    vi.spyOn(sessions, "readSessionPins").mockImplementation(() => {
      throw new sessions.SessionPinsReadError("webhooks", "/state/webhook-sessions.json", "parse");
    });
    const prune = vi.spyOn(sessions, "pruneSessions");
    await open();
    expect(prune).not.toHaveBeenCalled();
    const warn = records.find(record => record.message === "session retention skipped: could not read session pins");
    expect(warn?.level).toBe("warn");
    expect(warn?.context).toMatchObject({ source: "webhooks", reason: "parse" });
    expect(String(warn?.context?.fix)).toContain("/state/webhook-sessions.json.corrupt-");
  });

  it("an unreadable pin file on disk keeps every pinned session", async () => {
    config.sessions.retention.enabled = true;
    config.sessions.retention.maxAgeDays = 1;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "webhook-sessions.json"), '{"deploy": "s1', "utf8");
    const prune = vi.spyOn(sessions, "pruneSessions");
    await open();
    expect(prune).not.toHaveBeenCalled();
  });

  it("disabled retention does not read external pins or perform a prune", async () => {
    const pins = vi.spyOn(sessions, "readSessionPins");
    const prune = vi.spyOn(sessions, "pruneSessions");
    await open();
    expect(pins).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  });

  it("delete wrapper preserves trace then shell then bound original-store order", () => {
    const events: string[] = [];
    const store = { marker: "store", delete(id: string) { events.push(`${this.marker}:${id}`); } };
    installRuntimeSessionDelete(store, id => events.push(`trace:${id}`), { endSession: id => { events.push(`shell:${id}`); return []; } });
    store.delete("one");
    expect(events).toEqual(["trace:one", "shell:one", "store:one"]);
  });

  it("delete wrapper removes the session's saved tool outputs before the row", () => {
    const events: string[] = [];
    const store = { delete(id: string) { events.push(`store:${id}`); } };
    installRuntimeSessionDelete(
      store,
      id => events.push(`trace:${id}`),
      { endSession: id => { events.push(`shell:${id}`); return []; } },
      { removeSession: id => { events.push(`outputs:${id}`); } },
    );
    store.delete("one");
    expect(events).toEqual(["trace:one", "shell:one", "outputs:one", "store:one"]);
  });

  it("delete wrapper removes the chat's file checkpoints with it (ATO-1501)", async () => {
    const root = join(dir, "file-checkpoints");
    const checkpoints = new FileCheckpointStore(root);
    const file = join(dir, "notes.txt");
    await writeFile(file, "what the file said before");
    await checkpoints.capture("s-gone", file, "os.fs.write");
    await checkpoints.capture("s-kept", file, "os.fs.write");
    expect(existsSync(checkpoints.sessionDir("s-gone"))).toBe(true);

    const store = { delete: (_id: string) => undefined };
    installRuntimeSessionDelete(store, () => undefined, { endSession: () => [] }, undefined, checkpoints);
    store.delete("s-gone");

    await vi.waitFor(() => expect(existsSync(checkpoints.sessionDir("s-gone"))).toBe(false));
    expect(existsSync(checkpoints.sessionDir("s-kept"))).toBe(true);
  });

  it("a checkpoint removal that fails never stops the delete", () => {
    const events: string[] = [];
    const store = { delete: (id: string) => { events.push(`store:${id}`); } };
    installRuntimeSessionDelete(
      store, () => undefined, { endSession: () => [] }, undefined,
      { removeSession: () => { throw new Error("busy"); } },
    );
    expect(() => store.delete("one")).not.toThrow();
    expect(events).toEqual(["store:one"]);
  });

  it("delete wrapper retains failure precedence before the original deletion", () => {
    const events: string[] = [];
    const failure = new Error("trace failed");
    const store = { delete: (id: string) => { events.push(id); } };
    installRuntimeSessionDelete(store, () => { throw failure; }, { endSession: () => { events.push("shell"); return []; } });
    expect(() => store.delete("one")).toThrow(failure);
    expect(events).toEqual([]);
  });

  it("deferred and ephemeral factories allocate state without saving or opening traces", () => {
    const calls: string[] = [];
    const factories = createRuntimeSessionFactories(dir, { save: state => { calls.push(`save:${state.id}`); } }, state => { calls.push(`trace:${state.id}`); return null; });
    const metadata = { custom: 1 };
    const deferred = factories.createSession({ persist: false, metadata });
    const worker = factories.createEphemeralSession({ parentSessionId: deferred.id, taskId: "task" });
    expect(deferred.metadata).toBe(metadata);
    expect(deferred.workingDir).toBe(dir);
    expect(sessions.readFusionWorkerMeta(worker.metadata)).toEqual({ parentSessionId: deferred.id, taskId: "task" });
    expect(worker.id).not.toBe(deferred.id);
    const inherited = factories.createEphemeralSession({ parentSessionId: deferred.id, taskId: "inherited" }, join(dir, "other"));
    expect(inherited.workingDir).toBe(join(dir, "other"));
    expect(inherited.inheritedWorkspace).toBe(true);
    expect(worker.inheritedWorkspace).toBeUndefined();
    const local = factories.createEphemeralSession({ parentSessionId: deferred.id, taskId: "local" }, join(dir, "other"), false);
    expect(local.workingDir).toBe(join(dir, "other"));
    expect(local.inheritedWorkspace).toBeUndefined();
    expect(calls).toEqual([]);
    const persistent = factories.createSession();
    expect(calls).toEqual([`save:${persistent.id}`, `trace:${persistent.id}`]);
  });

  it("createSession starts in the folder it is given, else the launch folder (ATO-570)", () => {
    const factories = createRuntimeSessionFactories(dir, { save: () => {} }, () => null);
    expect(factories.createSession({ persist: false, workingDir: "/tmp/x" }).workingDir).toBe("/tmp/x");
    expect(factories.createSession({ persist: false }).workingDir).toBe(dir);
  });

  it("save failure stops recorder creation and propagates the original error", () => {
    const failure = new Error("save failed");
    const recorder = vi.fn(() => null);
    const factories = createRuntimeSessionFactories(dir, { save: () => { throw failure; } }, recorder);
    expect(() => factories.createSession()).toThrow(failure);
    expect(recorder).not.toHaveBeenCalled();
  });
});
