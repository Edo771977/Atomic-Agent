import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConfig, resetConfigCache, USER_CONFIG_VERSION } from "../config/index.js";
import { createEmptySessionState, SessionStore, type SessionState } from "../session/index.js";

import { exportCommand, parseExportArgs, writeExportFile } from "./export-command.js";

describe("atomic-agent export args (ATO-1054)", () => {
  it("defaults to Markdown on stdout with tool lines", () => {
    expect(parseExportArgs(["s-1"])).toEqual({ sessionId: "s-1", last: false, format: "markdown", out: null, tools: true, force: false });
  });

  it("takes --last, --format, --out and --no-tools", () => {
    expect(parseExportArgs(["--last", "--format", "docx", "--out", "a.docx", "--no-tools"])).toEqual({
      sessionId: "",
      last: true,
      format: "docx",
      out: "a.docx",
      tools: false,
      force: false,
    });
    expect(parseExportArgs(["s-1", "--out", "a.md", "--force"])).toMatchObject({ force: true });
  });

  it("refuses bad usage with a reason", () => {
    expect(parseExportArgs([])).toMatch(/session id or --last/);
    expect(parseExportArgs(["s-1", "--last"])).toMatch(/not both/);
    expect(parseExportArgs(["s-1", "s-2"])).toMatch(/one session id/);
    expect(parseExportArgs(["s-1", "--format", "rtf"])).toMatch(/unknown format: rtf/);
    expect(parseExportArgs(["s-1", "--out"])).toMatch(/--out needs a value/);
    expect(parseExportArgs(["s-1", "--bogus"])).toMatch(/unknown option/);
  });

  describe("writing --out", () => {
    let dir = "";
    afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

    it("does not overwrite an existing file without --force", () => {
      dir = mkdtempSync(join(tmpdir(), "export-out-"));
      const path = join(dir, "chat.md");
      writeFileSync(path, "keep me");
      expect(writeExportFile(path, "new", false)).toMatch(/already exists.*--force/);
      expect(readFileSync(path, "utf8")).toBe("keep me");
    });

    it("overwrites with --force and writes a new file either way", () => {
      dir = mkdtempSync(join(tmpdir(), "export-out-"));
      const path = join(dir, "chat.md");
      expect(writeExportFile(path, "first", false)).toBeNull();
      expect(readFileSync(path, "utf8")).toBe("first");
      writeFileSync(path, "old");
      expect(writeExportFile(path, Buffer.from("second"), true)).toBeNull();
      expect(readFileSync(path, "utf8")).toBe("second");
    });
  });
});

describe("atomic-agent export: what reaches the file", () => {
  let stateDir = "";
  let stdout = "";
  let stderr = "";
  const KEY = "9f3c2a7e81d4b06f5ac39e72d18b4f60";

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "export-cmd-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    writeFileSync(
      join(stateDir, "config.json"),
      JSON.stringify({
        version: USER_CONFIG_VERSION,
        llm: {
          activeTextProvider: "local-llama",
          providers: [
            { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" },
            { id: "cloud", kind: "aimlapi", apiKey: KEY, defaultChatModel: "m" },
          ],
        },
      }),
    );
    resetConfigCache();
    stdout = "";
    stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  function seed(state: SessionState): void {
    const store = new SessionStore({ dbFile: getConfig().paths.sessionsDbFile });
    try {
      store.save(state);
    } finally {
      store.close();
    }
  }

  const chat = (id: string): SessionState => ({
    ...createEmptySessionState({ id, workingDir: stateDir }),
    status: "completed",
    turns: [
      { kind: "user", text: "check the API", at: 1 },
      { kind: "assistant_tool_call", tool: "os.shell.run", args: { command: `printf %s ${KEY}` }, at: 2 },
      { kind: "tool_result", tool: "os.shell.run", status: "ok", summary: "x", at: 3 },
      { kind: "assistant_reply", text: "done", at: 4 },
    ],
  });

  it("masks a provider key stored in config.json, not only the .env ones", async () => {
    seed(chat("s-key"));
    expect(await exportCommand(["s-key"])).toBe(0);
    expect(stdout).toContain("printf");
    expect(stdout).not.toContain(KEY);
  });

  it("refuses an incognito chat by id", async () => {
    seed({ ...chat("s-incog"), incognito: { since: 1, owner: "x" } });
    expect(await exportCommand(["s-incog"])).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/incognito/);
  });
});
