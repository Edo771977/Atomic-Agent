import { describe, expect, it } from "vitest";
import { ApprovalGate, type ApprovalRequest } from "./approval-gate.js";

/**
 * The pending observer sees exactly the prompts a person is asked —
 * opened when one is emitted, closed when it is answered, denied for the
 * session or dropped because the turn was aborted. The approval-pending
 * notifier hangs its timers off it.
 */
function observed(gate: ApprovalGate): { opened: ApprovalRequest[]; closed: string[] } {
  const log = { opened: [] as ApprovalRequest[], closed: [] as string[] };
  gate.setPendingObserver({
    opened: (request) => log.opened.push(request),
    closed: (approvalId) => log.closed.push(approvalId),
  });
  return log;
}

describe("ApprovalGate pending observer", () => {
  it("opens on a prompt and closes when it is answered", async () => {
    const gate = new ApprovalGate({ emit: () => undefined });
    const log = observed(gate);
    const decision = gate.request({ approvalId: "a1", sessionId: "s", tool: "os.shell.run", category: "shell", reason: "r" });
    expect(log.opened.map((r) => r.approvalId)).toEqual(["a1"]);
    expect(log.closed).toEqual([]);
    gate.resolve({ approvalId: "a1", approved: true });
    await decision;
    expect(log.closed).toEqual(["a1"]);
  });

  it("closes on a session-wide denial and on an aborted turn", async () => {
    const gate = new ApprovalGate({ emit: () => undefined });
    const log = observed(gate);
    const denied = gate.request({ approvalId: "a1", sessionId: "s", tool: "t", category: "shell", reason: "r" });
    gate.denyPendingForSession("s", "gone");
    await denied;
    const controller = new AbortController();
    const aborted = gate.request(
      { approvalId: "a2", sessionId: "s", tool: "t", category: "shell", reason: "r" },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(aborted).rejects.toThrow();
    expect(log.closed).toEqual(["a1", "a2"]);
  });

  it("never sees a request nobody is asked (auto-approved or refused by policy)", async () => {
    const gate = new ApprovalGate({ emit: () => undefined, level: 5 });
    const log = observed(gate);
    await gate.request({ sessionId: "s", tool: "t", category: "shell", reason: "r" });
    const strict = new ApprovalGate({ emit: () => undefined });
    const strictLog = observed(strict);
    strict.setSessionPolicy("w", { onPrompt: "refuse", reason: "worker" });
    await strict.request({ sessionId: "w", tool: "t", category: "shell", reason: "r" });
    expect(log.opened).toEqual([]);
    expect(strictLog.opened).toEqual([]);
  });

  it("a throwing observer never breaks the prompt", async () => {
    const emitted: string[] = [];
    const gate = new ApprovalGate({ emit: (r) => emitted.push(r.approvalId) });
    gate.setPendingObserver({
      opened: () => { throw new Error("boom"); },
      closed: () => { throw new Error("boom"); },
    });
    const decision = gate.request({ approvalId: "a1", sessionId: "s", tool: "t", category: "shell", reason: "r" });
    expect(emitted).toEqual(["a1"]);
    expect(gate.resolve({ approvalId: "a1", approved: true })).toBe(true);
    await expect(decision).resolves.toMatchObject({ approved: true });
  });
});
