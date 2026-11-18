import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConfig, resetConfigCache } from "../config/index.js";
import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import { SessionStore } from "../session/index.js";

import { createEmptySessionState } from "../session/index.js";

import { handoffCommand, handoffToCommand } from "./handoff-command.js";

/**
 * Issue #68: `atag handoff --from <agent>` never widens what a transcript
 * from a constrained folder may reach. Continued in another folder it
 * carries that folder's restriction; the "newest elsewhere" fallback is
 * refused while constraints exist unless the session is named.
 */
describe("atag handoff --from with per-folder constraints (issue #68)", () => {
  let root: string;
  let source: string;
  let secret: string;
  let open: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "handoff-pc-"));
    const state = join(root, "state");
    source = join(root, "claude");
    secret = join(root, "secret");
    open = join(root, "open");
    for (const dir of [state, source, secret, open]) mkdirSync(dir, { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = state;
    writeConfig({ [secret]: { allowedProviders: ["local-llama"] } });
    resetConfigCache();
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { out.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { err.push(String(chunk)); return true; });
  });

  function writeConfig(constraints: Record<string, { allowedProviders: string[] }>): void {
    writeFileSync(join(process.env.ATOMIC_AGENT_STATE_DIR!, "config.json"), JSON.stringify({
      ...USER_CONFIG_DEFAULTS,
      llm: {
        ...USER_CONFIG_DEFAULTS.llm,
        activeTextProvider: "local-llama",
        activeEmbeddingProvider: "local-llama",
        providers: [
          { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" },
          { id: "claude-sub", kind: "subscription-cli", subscriptionCli: { cli: "claude" } },
        ],
      },
      projects: { ...USER_CONFIG_DEFAULTS.projects, constraints },
    }));
    resetConfigCache();
  }

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  function transcript(id: string, cwd: string, at: string): void {
    const dir = join(source, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: "user", cwd, timestamp: at, message: { role: "user", content: "the acme figures" } })}\n`);
    utimesSync(file, new Date(at), new Date(at));
  }

  function saved(): { workingDir: string; metadata?: Record<string, unknown> } {
    const { sessionId } = JSON.parse(out.join("")) as { sessionId: string };
    const store = new SessionStore({ dbFile: getConfig().paths.sessionsDbFile });
    try {
      return store.load(sessionId)!;
    } finally {
      store.close();
    }
  }

  it("refuses to fall back to the newest transcript of another folder", async () => {
    transcript("cc-secret", secret, "2026-11-02T10:00:00Z");
    expect(await handoffCommand(["--from", "claude-code", "--source", source, "--cwd", open, "--json"])).toBe(1);
    expect(out.join("") + err.join("")).toContain("--session");
  });

  it("a transcript named with --session and continued in another folder keeps its folder's restriction", async () => {
    transcript("cc-secret", secret, "2026-11-02T10:00:00Z");
    expect(await handoffCommand(["--from", "claude-code", "--source", source, "--session", "cc-secret", "--cwd", open, "--json"])).toBe(0);
    const session = saved();
    expect(session.workingDir).toBe(open);
    expect(session.metadata?.providerReadTaint).toMatchObject({ key: secret, allowedProviders: ["local-llama"], movedFrom: [secret] });
  });

  it("continued in its own folder, or from an open folder, adds nothing", async () => {
    transcript("cc-secret", secret, "2026-11-02T10:00:00Z");
    expect(await handoffCommand(["--from", "claude-code", "--source", source, "--cwd", secret, "--json"])).toBe(0);
    expect(saved().metadata?.providerReadTaint).toBeUndefined();
    out = [];
    transcript("cc-open", open, "2026-11-03T10:00:00Z");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    expect(await handoffCommand(["--from", "claude-code", "--source", source, "--session", "cc-open", "--cwd", elsewhere, "--json"])).toBe(0);
    expect(saved().metadata?.providerReadTaint).toBeUndefined();
  });

  describe("--to claude|codex", () => {
    const run = async (to: string, workingDir: string) => {
      const chat = { ...createEmptySessionState({ id: "s-chat", workingDir }), turns: [{ kind: "user" as const, text: "the acme figures", at: 1 }] };
      const store = { load: () => chat, listByWorkingDir: () => [chat], listRecent: () => [chat] };
      const written: string[] = [];
      const errors: string[] = [];
      const code = await handoffToCommand(["--to", to, "--session", "s-chat"], {
        store, stdout: (t) => void written.push(t), stderr: (t) => void errors.push(t), knownSecrets: [],
      });
      return { code, written: written.join(""), errors: errors.join("") };
    };

    it("refuses a brief of a restricted chat for an agent its folder does not allow", async () => {
      const res = await run("claude", secret);
      expect(res.code).toBe(1);
      expect(res.written).toBe("");
      expect(res.errors).toContain(secret);
      expect(res.errors).toContain("allowedProviders");
    });

    it("writes it when the folder allows that agent's provider, and refuses an agent that maps to none", async () => {
      writeConfig({ [secret]: { allowedProviders: ["local-llama", "claude-sub"] } });
      const ok = await run("claude", secret);
      expect(ok.code).toBe(0);
      expect(ok.written).toContain("acme");
      const codex = await run("codex", secret);
      expect(codex.code).toBe(1);
      expect(codex.written).toBe("");
    });

    it("an unrestricted chat is handed off as before", async () => {
      const res = await run("codex", open);
      expect(res.code).toBe(0);
      expect(res.written).toContain("acme");
    });
  });
});
