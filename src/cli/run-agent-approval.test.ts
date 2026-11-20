import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";

import type { CompletionResult } from "../llm/llama-server-client.js";
import { resetConfigCache } from "../config/index.js";

/**
 * Issue #95: `run` with piped stdin. A scripted model asks for one shell
 * command; what the approval prompt can (or cannot) get from stdin decides
 * what the tool result tells the model.
 */
const script = vi.hoisted(() => ({
  /** The tool calls the model makes, one per step, before it replies. */
  calls: [] as Array<{ tool: string; args: Record<string, unknown> }>,
  /** Every tool-result text the model was shown. */
  results: [] as string[],
  /** The messages each turn was sent. */
  messages: [] as string[],
}));

vi.mock("../runtime/bootstrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/bootstrap.js")>();
  const completion = (content: string): CompletionResult => ({
    content, reasoningContent: "", stop: true, truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 5, predictedTokens: 3 },
    cacheHitTokens: 0, slotId: 0, modelId: null,
  });
  const complete = async (params: { sessionId: string }): Promise<CompletionResult> => {
    if (params.sessionId.startsWith("reflection:")) return completion("");
    const next = script.calls.shift();
    return completion(JSON.stringify(next ?? { tool: "reply", args: { text: "done" } }));
  };
  return {
    ...actual,
    createAgentRuntime: async (options: Parameters<typeof actual.createAgentRuntime>[0]) => {
      const runtime = await actual.createAgentRuntime({
        ...options,
        overrides: { skipLlamaHealthCheck: true, disableStreaming: true, llamaComplete: complete },
      });
      const runTurn = runtime.runTurn;
      return Object.assign(runtime, {
        runTurn: async (...args: Parameters<typeof runTurn>) => {
          script.messages.push(args[1]);
          const result = await runTurn(...args);
          const stored = runtime.sessionStore.load(args[0].id);
          for (const row of stored?.turns ?? []) {
            if (row.kind === "tool_result") script.results.push(`${row.summary ?? ""}`);
          }
          return result;
        },
      });
    },
  };
});

const { runAgentCommand } = await import("./run-agent.js");

describe("run: approvals with piped stdin (issue #95)", () => {
  let stateDir: string;
  let workingDir: string;
  let stderr = "";
  const realStdin = process.stdin;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-cli-approval-state-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-cli-approval-cwd-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    writeFileSync(join(workingDir, "mark.cjs"), "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'ran.txt'), 'ran');\n");
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
    script.calls = [];
    script.results = [];
    script.messages = [];
    stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "stdin", { value: realStdin, configurable: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  /** Piped stdin: a Readable has no `isTTY`. */
  const feed = (lines: string[]): void => {
    Object.defineProperty(process, "stdin", { value: Readable.from(lines), configurable: true });
  };
  const runMarker = (): void => {
    script.calls = [{ tool: "os.shell.run", args: { cmd: "node", args: ["mark.cjs"] } }];
  };
  const shellResult = (): string => script.results.find((text) => text.includes("os.shell.run")) ?? script.results.join("\n");

  it("no answer on piped stdin (EOF) is an unavailable approval, not the user's refusal", async () => {
    runMarker();
    feed(["run the marker\n"]);
    await runAgentCommand(["--cwd", workingDir]);
    expect(existsSync(join(workingDir, "ran.txt"))).toBe(false);
    expect(shellResult()).toContain("approval unavailable (non-interactive run)");
    expect(shellResult()).not.toMatch(/user declined/i);
    expect(stderr).toContain("approval unavailable (non-interactive run)");
  });

  it("a piped next message instead of an answer is an unavailable approval too, and the message is kept", async () => {
    runMarker();
    feed(["run the marker\n", "what next?\n"]);
    await runAgentCommand(["--cwd", workingDir]);
    expect(script.messages).toEqual(["run the marker", "what next?"]);
    expect(existsSync(join(workingDir, "ran.txt"))).toBe(false);
    expect(shellResult()).toContain("approval unavailable (non-interactive run)");
    expect(shellResult()).not.toMatch(/user declined/i);
  });

  it("the same call retried in the turn after an unavailable approval is refused without asking again", async () => {
    script.calls = [
      { tool: "os.shell.run", args: { cmd: "node", args: ["mark.cjs"] } },
      { tool: "os.shell.run", args: { cmd: "node", args: ["mark.cjs"] } },
    ];
    feed(["run the marker\n"]);
    await runAgentCommand(["--cwd", workingDir]);
    expect(stderr.match(/approval required for tool/g) ?? []).toHaveLength(1);
    expect(existsSync(join(workingDir, "ran.txt"))).toBe(false);
  });

  it("an explicit n on piped stdin is still the user's refusal", async () => {
    runMarker();
    feed(["run the marker\n", "n\n"]);
    await runAgentCommand(["--cwd", workingDir]);
    expect(existsSync(join(workingDir, "ran.txt"))).toBe(false);
    expect(shellResult()).toMatch(/The user declined this os\.shell\.run call/);
    expect(shellResult()).not.toContain("approval unavailable");
  });

  describe("--allow-command (issue #95)", () => {
    const allow = ["--allow-command", "node mark.cjs"];

    it("runs the listed command unasked in a piped run, and its result reaches the turn", async () => {
      runMarker();
      feed(["run the marker\n"]);
      expect(await runAgentCommand(["--cwd", workingDir, ...allow])).toBe(0);
      expect(existsSync(join(workingDir, "ran.txt"))).toBe(true);
      expect(shellResult()).not.toContain("approval unavailable");
      expect(shellResult()).not.toMatch(/declined|not run/i);
      expect(stderr).toContain("approved by --allow-command: node mark.cjs");
      expect(stderr).not.toContain("approval required for tool");
    });

    it("names the allowed command in an unavailable refusal, so the model can retry it in that form", async () => {
      script.calls = [{ tool: "os.shell.run", args: { cmd: "node", args: ["other.cjs"] } }];
      feed(["run the other one\n"]);
      await runAgentCommand(["--cwd", workingDir, ...allow]);
      expect(shellResult()).toContain("approval unavailable (non-interactive run)");
      expect(shellResult()).toContain("`node mark.cjs`");
    });

    it("still holds a different command", async () => {
      writeFileSync(join(workingDir, "other.cjs"), "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'ran.txt'), 'other');\n");
      script.calls = [{ tool: "os.shell.run", args: { cmd: "node", args: ["other.cjs"] } }];
      feed(["run the other one\n"]);
      await runAgentCommand(["--cwd", workingDir, ...allow]);
      expect(existsSync(join(workingDir, "ran.txt"))).toBe(false);
      expect(shellResult()).toContain("approval unavailable (non-interactive run)");
    });

    it("still holds the same command run in a parent folder", async () => {
      const parentMarker = join(workingDir, "..", "ran.txt");
      rmSync(parentMarker, { force: true });
      script.calls = [{ tool: "os.shell.run", args: { cmd: "node", args: ["mark.cjs"], cwd: ".." } }];
      feed(["run the marker up there\n"]);
      await runAgentCommand(["--cwd", workingDir, ...allow]);
      expect(shellResult()).toContain("approval unavailable (non-interactive run)");
      expect(existsSync(parentMarker)).toBe(false);
    });

    it("is not implied by --auto-approve-project", async () => {
      runMarker();
      feed(["run the marker\n"]);
      await runAgentCommand(["--cwd", workingDir, "--auto-approve-project"]);
      expect(existsSync(join(workingDir, "ran.txt"))).toBe(false);
      expect(shellResult()).toContain("approval unavailable (non-interactive run)");
    });

    it("in an interactive run, n to a command it does not list still blocks it", async () => {
      writeFileSync(join(workingDir, "other.cjs"), "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'ran.txt'), 'other');\n");
      script.calls = [{ tool: "os.shell.run", args: { cmd: "node", args: ["other.cjs"] } }];
      const tty = Object.assign(Readable.from(["run the other one\n", "n\n"]), { isTTY: true });
      Object.defineProperty(process, "stdin", { value: tty, configurable: true });
      await runAgentCommand(["--cwd", workingDir, ...allow]);
      expect(existsSync(join(workingDir, "ran.txt"))).toBe(false);
      expect(shellResult()).toMatch(/The user declined this os\.shell\.run call/);
    });

    // Real command lines the model may send as one `cmd` (run through a
    // shell): none is the listed direct exec, whatever its first words.
    it.each([
      ["a redirect out of the folder", "node mark.cjs > ../outside.txt"],
      ["an appending redirect", "node mark.cjs >> ../outside.txt"],
      ["an input redirect", "node mark.cjs < ../outside.txt"],
      ["a background job", "node mark.cjs &"],
      ["a comment hiding a second command", "node mark.cjs # & touch ../outside.txt"],
      ["a sequence", "node mark.cjs ; touch ../outside.txt"],
      ["a glob", "node mark*.cjs"],
      ["a quoted word", `node "mark.cjs"`],
    ])("holds a line with %s", async (_label, line) => {
      writeFileSync(join(workingDir, "..", "outside.txt"), "keep me");
      script.calls = [{ tool: "os.shell.run", args: { cmd: line } }];
      feed(["run it\n"]);
      await runAgentCommand(["--cwd", workingDir, ...allow]);
      expect(stderr).not.toContain("approved by --allow-command");
      expect(shellResult()).toContain("approval unavailable (non-interactive run)");
      expect(existsSync(join(workingDir, "ran.txt"))).toBe(false);
      expect(readFileSync(join(workingDir, "..", "outside.txt"), "utf8")).toBe("keep me");
      rmSync(join(workingDir, "..", "outside.txt"), { force: true });
    });

    it("holds the listed command in a folder that links outside --cwd", async () => {
      const outside = mkdtempSync(join(tmpdir(), "atomic-cli-approval-outside-"));
      writeFileSync(join(outside, "mark.cjs"), "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'ran.txt'), 'ran');\n");
      symlinkSync(outside, join(workingDir, "link"), "dir");
      script.calls = [{ tool: "os.shell.run", args: { cmd: "node", args: ["mark.cjs"], cwd: "link" } }];
      feed(["run it there\n"]);
      await runAgentCommand(["--cwd", workingDir, ...allow]);
      expect(stderr).not.toContain("approved by --allow-command");
      expect(existsSync(join(outside, "ran.txt"))).toBe(false);
      rmSync(outside, { recursive: true, force: true });
    });

    it("holds the listed command under another argv[0] spelling (NODE)", async () => {
      script.calls = [{ tool: "os.shell.run", args: { cmd: "NODE", args: ["mark.cjs"] } }];
      feed(["run it\n"]);
      await runAgentCommand(["--cwd", workingDir, ...allow]);
      expect(stderr).not.toContain("approved by --allow-command");
    });

    it("holds a direct exec whose glob the tool expanded to the listed words", async () => {
      script.calls = [{ tool: "os.shell.run", args: { cmd: "node", args: ["mark*.cjs"] } }];
      feed(["run it\n"]);
      await runAgentCommand(["--cwd", workingDir, ...allow]);
      expect(stderr).not.toContain("approved by --allow-command");
      expect(existsSync(join(workingDir, "ran.txt"))).toBe(false);
    });

    it("pins the real node: a node planted in --cwd/bin ahead on PATH never runs", async () => {
      const bin = join(workingDir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "node"), `#!/bin/sh\necho pwned > "${join(workingDir, "pwned.txt")}"\n`);
      chmodSync(join(bin, "node"), 0o755);
      const realPath = process.env.PATH;
      process.env.PATH = `${bin}${delimiter}${realPath ?? ""}`;
      try {
        runMarker();
        feed(["run the marker\n"]);
        await runAgentCommand(["--cwd", workingDir, ...allow]);
      } finally {
        process.env.PATH = realPath;
      }
      expect(existsSync(join(workingDir, "pwned.txt"))).toBe(false);
      expect(existsSync(join(workingDir, "ran.txt"))).toBe(true);
    });

    it("approves the common one-string form {cmd: \"node mark.cjs\"} and runs it directly", async () => {
      script.calls = [{ tool: "os.shell.run", args: { cmd: "node mark.cjs" } }];
      feed(["run the marker\n"]);
      await runAgentCommand(["--cwd", workingDir, ...allow]);
      expect(stderr).toContain("approved by --allow-command: node mark.cjs");
      expect(existsSync(join(workingDir, "ran.txt"))).toBe(true);
    });

    it("still holds a one-string form with a doubled space or a character outside the plain set", async () => {
      for (const cmd of ["node  mark.cjs", "node mark.cjs\t", "node 'mark.cjs'"]) {
        script.calls = [{ tool: "os.shell.run", args: { cmd } }];
        feed(["run it\n"]);
        await runAgentCommand(["--cwd", workingDir, ...allow]);
      }
      expect(stderr).not.toContain("approved by --allow-command");
      expect(existsSync(join(workingDir, "ran.txt"))).toBe(false);
    });

    it("refuses a value that is not one simple command (exit 2)", async () => {
      feed([]);
      expect(await runAgentCommand(["--cwd", workingDir, "--allow-command", "node a.cjs && rm -rf x"])).toBe(2);
      expect(await runAgentCommand(["--cwd", workingDir, "--allow-command"])).toBe(2);
    });
  });
});
