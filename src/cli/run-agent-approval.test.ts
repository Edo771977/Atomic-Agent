import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("an explicit n on piped stdin is still the user's refusal", async () => {
    runMarker();
    feed(["run the marker\n", "n\n"]);
    await runAgentCommand(["--cwd", workingDir]);
    expect(existsSync(join(workingDir, "ran.txt"))).toBe(false);
    expect(shellResult()).toMatch(/The user declined this os\.shell\.run call/);
    expect(shellResult()).not.toContain("approval unavailable");
  });
});
