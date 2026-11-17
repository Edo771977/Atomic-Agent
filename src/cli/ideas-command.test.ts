import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getConfig, resetConfigCache } from "../config/index.js";
import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import { SessionStore, createEmptySessionState } from "../session/index.js";
import { IdeaStore, TaskStore } from "../tasks/index.js";

import { ideasCommand } from "./ideas-command.js";

describe("ideasCommand", () => {
  let stateDir: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-ideas-cli-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  function failedTask(message: string): string {
    const store = new TaskStore({ dbFile: getConfig().paths.tasksDbFile });
    try {
      const t = store.create({ userMessage: message, origin: "cli", maxAttempts: 1 });
      store.markRunning(t.id);
      store.markFailed(t.id, { category: "model", message: "empty reply" });
      return t.id;
    } finally {
      store.close();
    }
  }

  function onlyNewIdeaId(): string {
    const ideas = new IdeaStore({ dbFile: getConfig().paths.tasksDbFile });
    try {
      const list = ideas.list({ status: "new" });
      expect(list).toHaveLength(1);
      return list[0]!.id;
    } finally {
      ideas.close();
    }
  }

  it("prints help without a subcommand", async () => {
    expect(await ideasCommand([])).toBe(0);
    expect(out.join("")).toMatch(/atomic-agent ideas/);
  });

  it("refresh lists a failed task as an idea with its evidence", async () => {
    failedTask("summarise the notes");
    expect(await ideasCommand(["refresh"])).toBe(0);
    const text = out.join("");
    expect(text).toMatch(/1 new, 0 retired, 1 waiting/);
    expect(text).toMatch(/Retry: summarise the notes/);
    expect(text).toMatch(/evidence \(task .+\): empty reply/);
  });

  it("accept --prompt files a pending task; a second accept fails", async () => {
    failedTask("summarise the notes");
    await ideasCommand(["refresh"]);
    const id = onlyNewIdeaId();
    expect(await ideasCommand(["accept", id, "--prompt", "summarise only today's notes"])).toBe(0);
    const printed = JSON.parse(out.slice(-1)[0]!) as {
      idea: { status: string; taskId: string };
      task: { id: string; userMessage: string; status: string };
    };
    expect(printed.idea).toMatchObject({ status: "accepted", taskId: printed.task.id });
    expect(printed.task).toMatchObject({ userMessage: "summarise only today's notes", status: "pending" });
    expect(await ideasCommand(["accept", id])).toBe(1);
    expect(err.join("")).toMatch(/already accepted/);
  });

  describe("a Retry keeps the original chat's restriction (issue #68)", () => {
    function constrain(dir: string): void {
      writeFileSync(join(stateDir, "config.json"), JSON.stringify({
        ...USER_CONFIG_DEFAULTS,
        projects: { ...USER_CONFIG_DEFAULTS.projects, constraints: { [dir]: { allowedProviders: ["local-llama"] } } },
      }));
      resetConfigCache();
    }

    function blockedTaskIn(sessionId: string, workingDir: string): void {
      const sessions = new SessionStore({ dbFile: getConfig().paths.sessionsDbFile });
      const store = new TaskStore({ dbFile: getConfig().paths.tasksDbFile });
      try {
        sessions.save(createEmptySessionState({ id: sessionId, workingDir }));
        const t = store.create({ sessionId, userMessage: "summarise the acme figures", origin: "cli", maxAttempts: 1 });
        store.markRunning(t.id);
        store.markBlocked(t.id, { category: "transport", message: "spend ceiling reached" });
      } finally {
        store.close();
        sessions.close();
      }
    }

    it("a retry whose constrained folder is gone opens a new chat that keeps the folder's restriction", async () => {
      const secret = mkdtempSync(join(tmpdir(), "atomic-ideas-secret-"));
      constrain(secret);
      blockedTaskIn("s-secret", secret);
      await ideasCommand(["refresh"]);
      const id = onlyNewIdeaId();
      rmSync(secret, { recursive: true, force: true });
      out = [];
      expect(await ideasCommand(["accept", id])).toBe(0);
      const printed = JSON.parse(out.join("")) as { task: { sessionId: string | null } };
      expect(printed.task.sessionId).not.toBeNull();
      const sessions = new SessionStore({ dbFile: getConfig().paths.sessionsDbFile });
      try {
        expect(sessions.load(printed.task.sessionId!)?.metadata?.providerReadTaint).toMatchObject({ key: secret, allowedProviders: ["local-llama"] });
      } finally {
        sessions.close();
      }
    });

    it("a retry whose chat was deleted after the card was offered keeps the recorded restriction", async () => {
      const secret = mkdtempSync(join(tmpdir(), "atomic-ideas-rec-"));
      constrain(secret);
      blockedTaskIn("s-rec", secret);
      await ideasCommand(["refresh"]);
      const id = onlyNewIdeaId();
      const sessions = new SessionStore({ dbFile: getConfig().paths.sessionsDbFile });
      sessions.delete("s-rec");
      sessions.close();
      rmSync(secret, { recursive: true, force: true });
      out = [];
      expect(await ideasCommand(["accept", id])).toBe(0);
      const printed = JSON.parse(out.join("")) as { task: { sessionId: string | null } };
      const reopened = new SessionStore({ dbFile: getConfig().paths.sessionsDbFile });
      try {
        expect(reopened.load(printed.task.sessionId!)?.metadata?.providerReadTaint).toMatchObject({ key: secret, allowedProviders: ["local-llama"] });
      } finally {
        reopened.close();
      }
    });

    it("refuses and retires a retry whose chat was gone before its restriction was recorded", async () => {
      constrain("/work/secret");
      blockedTaskIn("s-gone", stateDir);
      const sessions = new SessionStore({ dbFile: getConfig().paths.sessionsDbFile });
      sessions.delete("s-gone");
      sessions.close();
      await ideasCommand(["refresh"]);
      const id = onlyNewIdeaId();
      expect(await ideasCommand(["accept", id])).toBe(1);
      expect(err.join("")).toMatch(/restriction cannot be checked/);
      const ideas = new IdeaStore({ dbFile: getConfig().paths.tasksDbFile });
      try {
        expect(ideas.get(id)?.status).toBe("dismissed");
      } finally {
        ideas.close();
      }
    });
  });

  it("dismiss keeps the idea from coming back", async () => {
    failedTask("summarise the notes");
    await ideasCommand(["refresh"]);
    const id = onlyNewIdeaId();
    expect(await ideasCommand(["dismiss", id])).toBe(0);
    out = [];
    expect(await ideasCommand(["refresh"])).toBe(0);
    expect(out.join("")).toMatch(/0 new, 0 retired, 0 waiting/);
  });

  it("rejects an unknown status", async () => {
    expect(await ideasCommand(["list", "--status", "done"])).toBe(1);
    expect(err.join("")).toMatch(/unknown idea status/);
  });
});
