import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createEmptySessionState } from "../session/session-state.js";
import { handoffToCommand, parseHandoffToArgs, type HandoffToStore } from "./handoff-command.js";

function chat() {
  const state = createEmptySessionState({ id: "s-1", workingDir: "/work", metadata: { title: "Task" } });
  state.turns = [{ kind: "user", text: "Ship the fix", at: 1 }];
  return state;
}

function storeWith(state = chat()): HandoffToStore {
  return {
    load: (id: string) => (id === state.id ? state : null),
    listByWorkingDir: () => [state],
    listRecent: () => [state],
  } as unknown as HandoffToStore;
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "handoff-to-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseHandoffToArgs (ATO-1158)", () => {
  it("needs a known target and refuses mixing with --from", () => {
    expect(parseHandoffToArgs(["--to"])).toHaveProperty("error");
    expect(parseHandoffToArgs(["--to", "hermes"])).toEqual({ error: "--to must be claude or codex, not hermes" });
    expect(parseHandoffToArgs(["--to", "codex", "--from", "codex"])).toHaveProperty("error");
    expect(parseHandoffToArgs(["--to", "claude", "--out", "x.md"])).toEqual({
      to: "claude",
      out: "x.md",
      session: "latest",
      cwd: null,
      force: false,
    });
  });
});

describe("handoffToCommand (ATO-1158)", () => {
  it("with --out writes only that file", async () => {
    const dir = tempDir();
    let printed = "";
    const code = await handoffToCommand(["--to", "claude", "--out", "x.md"], {
      store: storeWith(),
      cwd: dir,
      stdout: (text) => {
        printed += text;
      },
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(readdirSync(dir)).toEqual(["x.md"]);
    expect(readFileSync(join(dir, "x.md"), "utf8")).toContain("> Ship the fix");
    expect(printed).toBe("");
  });

  it("without --out prints to stdout and writes no file", async () => {
    const dir = tempDir();
    let printed = "";
    const code = await handoffToCommand(["--to", "codex"], {
      store: storeWith(),
      cwd: dir,
      stdout: (text) => {
        printed += text;
      },
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(printed).toContain("# Handoff: Task");
    expect(printed).toContain("Codex");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("exits 1 when there is no chat to hand off", async () => {
    const empty = {
      load: () => null,
      listByWorkingDir: () => [],
      listRecent: () => [],
    } as unknown as HandoffToStore;
    let err = "";
    const code = await handoffToCommand(["--to", "claude", "--session", "s-missing"], {
      store: empty,
      stdout: () => undefined,
      stderr: (text) => {
        err += text;
      },
    });
    expect(code).toBe(1);
    expect(err).toContain("s-missing");
  });
});

describe("handoffToCommand keeps what export keeps out", () => {
  const quiet = { stdout: () => undefined, stderr: () => undefined };

  it("refuses an incognito chat", async () => {
    const state = chat();
    state.incognito = { createdAt: 1 } as never;
    let printed = "";
    const code = await handoffToCommand(["--to", "claude"], {
      ...quiet,
      store: storeWith(state),
      stdout: (text) => { printed += text; },
    });
    expect(code).toBe(1);
    expect(printed).toBe("");
  });

  it("masks the runtime's known secrets", async () => {
    const state = chat();
    state.turns = [{ kind: "user", text: "use key plainshapelesskey42 for it", at: 1 }];
    let printed = "";
    const code = await handoffToCommand(["--to", "codex"], {
      ...quiet,
      store: storeWith(state),
      knownSecrets: [{ label: "OPENROUTER_API_KEY", value: "plainshapelesskey42" }],
      stdout: (text) => { printed += text; },
    });
    expect(code).toBe(0);
    expect(printed).not.toContain("plainshapelesskey42");
  });

  it("never overwrites --out unless --force", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "x.md"), "mine");
    expect(await handoffToCommand(["--to", "claude", "--out", "x.md"], { ...quiet, store: storeWith(), cwd: dir })).toBe(1);
    expect(readFileSync(join(dir, "x.md"), "utf8")).toBe("mine");
    expect(await handoffToCommand(["--to", "claude", "--out", "x.md", "--force"], { ...quiet, store: storeWith(), cwd: dir })).toBe(0);
    expect(readFileSync(join(dir, "x.md"), "utf8")).toContain("Ship the fix");
  });
});
