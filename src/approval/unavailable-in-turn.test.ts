import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildOsFsWriteTool } from "../tools/os/fs/fs-write.js";
import { buildOsShellTool } from "../tools/os/shell/shell.js";
import type { ToolContext } from "../tools/tool-registry.js";
import { ApprovalGate, type ApprovalDecision, type ApprovalRequest } from "./approval-gate.js";

/**
 * Issue #95 review: after an approval nobody could answer (a piped `run`
 * with no answer), an identical retry in the same turn must not reach a
 * prompt again, or a model can loop on it until its step budget runs
 * out. It is refused unasked, and still reads as nobody's decision.
 */
describe("a call refused as unavailable is not asked again in the same turn", () => {
  let dir: string;
  let gate: ApprovalGate;
  let prompts: ApprovalRequest[];
  const unavailable: Omit<ApprovalDecision, "approvalId"> = {
    approved: false, automatic: true, unavailable: true, reason: "approval unavailable (non-interactive run): nobody could be asked",
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "unavailable-in-turn-"));
    prompts = [];
    gate = new ApprovalGate({
      level: 1,
      emit: (request) => {
        prompts.push(request);
        queueMicrotask(() => gate.resolve({ approvalId: request.approvalId, ...unavailable }));
      },
    });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const ctx = (): ToolContext => ({ workingDir: dir, sessionId: "s-1", stepIndex: 0, signal: new AbortController().signal });
  /** The text the model is shown for a refused call (the tool throws it). */
  const outcome = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run();
      return "ran";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  const shell = () => outcome(() => buildOsShellTool({ approvals: gate, approvalRequired: true }).run({ cmd: "node", args: ["mark.cjs"] }, ctx()));
  const write = () => outcome(() => buildOsFsWriteTool({ approvals: gate, approvalRequired: true }).run({ path: join(dir, "x.txt"), content: "x" }, ctx()));

  it("refuses the identical retry without a prompt, worded as nobody's decision", async () => {
    const first = await shell();
    const second = await shell();
    expect(prompts).toHaveLength(1);
    for (const text of [first, second]) {
      expect(text).toContain("approval unavailable (non-interactive run)");
      expect(text).not.toMatch(/user (already )?declined/i);
    }
  });

  it("refuses a shell write of a file whose write was unavailable, unasked, and asks again in the next turn", async () => {
    await write();
    const viaShell = await outcome(() => buildOsShellTool({ approvals: gate, approvalRequired: true }).run({ cmd: "printf x > x.txt" }, ctx()));
    expect(prompts).toHaveLength(1);
    expect(viaShell).toContain("approval unavailable (non-interactive run)");
    expect(gate.hasDeclinedTarget({ sessionId: "s-1", tool: "os.shell.run", category: "shell", targetPaths: [join(dir, "x.txt")] })).toBe(true);
    gate.forgetDeclined("s-1");
    await shell();
    expect(prompts).toHaveLength(2);
  });
});
