import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { getConfig, resetConfigCache } from "../config/index.js";
import { SessionStore } from "../session/session-store.js";
import { createEmptySessionState } from "../session/session-state.js";
import { TaskStore } from "../tasks/index.js";
import { importCommand } from "./import-command.js";

it("wires session privacy into the task store supplied to the CLI importer", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "import-privacy-"));
  const previous = process.env.ATOMIC_AGENT_STATE_DIR;
  process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
  resetConfigCache();
  const sessions = new SessionStore({ dbFile: getConfig().paths.sessionsDbFile });
  sessions.save(createEmptySessionState({ id: "private-import", workingDir: stateDir, incognito: sessions.newIncognitoMark() }));
  const sourceDir = join(stateDir, "source");
  mkdirSync(join(sourceDir, "cron"), { recursive: true });
  writeFileSync(join(sourceDir, "cron", "jobs.json"), JSON.stringify({ jobs: [{
    id: "privacy-cron", prompt: "fixture", enabled: true, schedule: { kind: "interval", minutes: 5 },
  }] }));
  const create = TaskStore.prototype.create;
  // Exercise the CLI's injected store with a bound incognito session, as future import mappings may supply.
  vi.spyOn(TaskStore.prototype, "create").mockImplementation(function (this: TaskStore, input, now) {
    return create.call(this, { ...input, sessionId: "private-import" }, now);
  });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    expect(await importCommand(["hermes", "--source", sourceDir, "--include", "cron", "--exclude", "sessions", "--yes"])).toBe(0);
    sessions.delete("private-import");
    const tasks = new TaskStore({ dbFile: getConfig().paths.tasksDbFile });
    try { expect(tasks.list()[0]?.incognito).toBe(true); }
    finally { tasks.close(); }
  } finally {
    vi.restoreAllMocks();
    sessions.close();
    if (previous === undefined) delete process.env.ATOMIC_AGENT_STATE_DIR;
    else process.env.ATOMIC_AGENT_STATE_DIR = previous;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
