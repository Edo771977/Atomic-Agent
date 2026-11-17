import { describe, expect, it } from "vitest";

import { approvalPushMessage, lastReplyOfTurn, turnPushMessage } from "./phone-push.js";
import type { ChatMessage } from "./tui-state.js";

const msg = (
  role: ChatMessage["role"],
  text: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({ id: `${role}-${text}`, role, text, timestamp: 0, ...extra });

describe("lastReplyOfTurn (ATO-1129)", () => {
  it("is the last real answer after the last prompt", () => {
    expect(
      lastReplyOfTurn([
        msg("user", "old question"),
        msg("assistant", "old answer"),
        msg("user", "fix the build"),
        msg("assistant", "working on it", { progressNote: true }),
        msg("system", "tool ran"),
        msg("assistant", "Build fixed."),
      ]),
    ).toBe("Build fixed.");
  });

  it("does not reach back into the previous turn", () => {
    expect(
      lastReplyOfTurn([
        msg("user", "q1"),
        msg("assistant", "a1"),
        msg("user", "q2"),
        msg("system", "Turn failed"),
      ]),
    ).toBeNull();
  });

  it("looks past a steering message folded into the running turn", () => {
    expect(
      lastReplyOfTurn([
        msg("user", "q"),
        msg("assistant", "the answer"),
        msg("user", "also check X", { steered: true }),
      ]),
    ).toBe("the answer");
  });
});

describe("phone push for a private session (issue #33, ATO-586)", () => {
  const turn = {
    outcome: "completed" as const,
    reason: "provider said: the contract of Acme is invalid",
    stepCount: 3,
    durationMs: 90_000,
    messages: [msg("user", "read the contract"), msg("assistant", "Acme owes 4M")],
    workingDirName: "acme",
  };

  it("names the reply and the folder of an ordinary session", () => {
    const message = turnPushMessage(turn, { private: false });
    expect(message.body).toContain("Acme owes 4M");
    expect(approvalPushMessage("os.shell.run", { private: false }).body).toContain("os.shell.run");
  });

  it("sends neither the reply, the failure text, the folder nor the tool of a restricted or incognito one", () => {
    const done = turnPushMessage(turn, { private: true });
    const failed = turnPushMessage({ ...turn, outcome: "failed" }, { private: true });
    for (const message of [done, failed]) {
      expect(JSON.stringify(message)).not.toMatch(/Acme|acme|contract/);
    }
    expect(approvalPushMessage("os.shell.run", { private: true }).body).not.toContain("os.shell.run");
  });
});
