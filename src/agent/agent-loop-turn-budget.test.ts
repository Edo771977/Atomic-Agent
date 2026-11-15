import { describe, expect, it } from "vitest";

import { AgentLoop } from "./agent-loop.js";
import type { AgentLoopEvent, RunTurnOptions } from "./agent-loop.js";
import type { LlmStreamParams } from "./step/step-contract.js";
import { buildDefaultToolRegistry } from "../tools/index.js";
import { SlotManager } from "../llm/slot-manager.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import { TurnBudgetExhaustedError } from "../llm/reliability/turn-budget-error.js";
import { DailySpendLimitError } from "../llm/reliability/spend-limit-error.js";
import type { CapabilitiesSummary, ToolDescriptor } from "../prompt/stable-prefix.js";

/**
 * Issue #29: the fusion turn's USD cap refused the orchestrator's next
 * request. The turn takes one final no-tools report step (marked
 * `finalReport`, a 1024-token ceiling) and ends with reason `budget`
 * instead of failing with no report.
 */

function completion(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: "mock",
  };
}

const replyCall = (text: string) => JSON.stringify([{ tool: "reply", args: { text } }]);

const TOOLS: ToolDescriptor[] = [
  { name: "reply", summary: "Reply to the user.", argsSchema: '{"text": string}' },
  { name: "finish", summary: "Finish the session.", argsSchema: '{"summary": string}' },
];

const CAPS: CapabilitiesSummary = {
  platform: "darwin",
  arch: "arm64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};

const exhausted = () => new TurnBudgetExhaustedError({ capUsd: 1, accountedUsd: 1.13, heldUsd: 0, requestUsd: 0 });

function loop(script: (call: number, params: LlmStreamParams) => string) {
  const calls: LlmStreamParams[] = [];
  const events: AgentLoopEvent[] = [];
  const agent = new AgentLoop({
    registry: buildDefaultToolRegistry(),
    slotManager: new SlotManager(1),
    grammar: 'root ::= "ok"',
    toolTransport: "grammar",
    toolCallAdapter: null,
    supportsSlotAffinity: false,
    llmComplete: async (params) => {
      calls.push(params);
      return completion(script(calls.length, params));
    },
    toolDescriptors: TOOLS,
    capabilities: CAPS,
    skillCatalog: [],
    onEvent: (event) => events.push(event),
  });
  return { agent, calls, events };
}

const options = (): RunTurnOptions => ({
  userMessage: "fan the work out",
  maxSteps: 10,
  taskMaxSteps: 10,
  signal: new AbortController().signal,
});

describe("AgentLoop after the fusion turn cap refused a request (issue #29)", () => {
  it("runs one final no-tools report step and ends the turn with reason budget", async () => {
    const { agent, calls, events } = loop((call) => {
      if (call === 1) throw exhausted();
      return replyCall("Two of three parts are done; the third is left.");
    });
    const result = await agent.runTurn(createEmptySessionState({ id: "s-cap" }), options());
    expect(calls).toHaveLength(2);
    expect(calls[0]!.finalReport).toBeUndefined();
    expect(calls[1]!.finalReport).toBe(true);
    expect(calls[1]!.maxTokens).toBe(1024);
    expect(calls[1]!.prompt).toContain("turn cap is used up");
    expect(result.reason).toBe("budget");
    expect(result.session.turns.at(-1)).toMatchObject({ text: "Two of three parts are done; the third is left." });
    expect(events.some((e) => e.type === "loop_failed")).toBe(false);
    expect(events).toContainEqual({ type: "loop_completed", reason: "budget", budget: { spentUsd: 1.13, capUsd: 1 } });
    expect(events.find((e) => e.type === "turn_finished")).toMatchObject({ reason: "budget", budget: { spentUsd: 1.13, capUsd: 1 } });
  });

  it("stops with reason budget and no further call when the final report is refused too", async () => {
    const { agent, calls, events } = loop(() => { throw exhausted(); });
    const result = await agent.runTurn(createEmptySessionState({ id: "s-cap2" }), options());
    expect(calls).toHaveLength(2);
    expect(result.reason).toBe("budget");
    expect(events.some((e) => e.type === "loop_failed")).toBe(false);
    expect(events.find((e) => e.type === "turn_finished")).toMatchObject({ reason: "budget" });
  });

  it("takes no final call when the daily limit is what refused", async () => {
    const { agent, calls } = loop(() => { throw new DailySpendLimitError({ spentUsd: 5, limitUsd: 5, providerId: "cloud" }); });
    const result = await agent.runTurn(createEmptySessionState({ id: "s-day" }), options());
    expect(calls).toHaveLength(1);
    expect(result.reason).toBe("failed");
  });
});
