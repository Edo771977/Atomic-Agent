import { describe, expect, it } from "vitest";

import { resolveStepGrammar } from "./step-inference.js";
import { buildReasoningPreludeRules, withReasoningBudget } from "../../llm/grammar/reasoning-prelude.js";
import { LOCAL_CHAT_REASONING_BUDGET_TOKENS, reasoningBudgetChars } from "../../llm/reasoning-budget.js";
import type { StepDependencies } from "./step-contract.js";

// ATO-490: the chat's reasoning level reaches a local thinking model's
// grammar as the turn's `reasoningBudgetTokens` (mapped in `AgentLoop`).
const grammar = `root ::= think-prelude tool-call-array\ntool-call-array ::= "[" "]"\n${buildReasoningPreludeRules(
  "think", "</think>", undefined, reasoningBudgetChars(1_500),
)}\n`;
const deps = { registry: undefined, grammar } as unknown as Pick<
  StepDependencies, "registry" | "isFusionOrchestrator" | "grammar"
>;

/** The rules `think-body` reaches, in order: the live chain, not leftovers. */
function liveBodyChain(g: string): string[] {
  const rules = new Map(g.split("\n").filter((l) => l.includes(" ::= ")).map((l) => [l.slice(0, l.indexOf(" ::= ")), l]));
  const chain: string[] = [];
  let name: string | undefined = "think-body";
  while (name !== undefined && rules.has(name)) {
    const line: string = rules.get(name)!;
    chain.push(line);
    name = /\b(think-body-\d+)\b/.exec(line.slice(line.indexOf(" ::= ")))?.[1];
  }
  return chain;
}

describe("resolveStepGrammar with a chat reasoning level (ATO-490)", () => {
  it("sends the base grammar byte-identical when no level is picked", () => {
    expect(resolveStepGrammar({}, deps, [], false, false)).toBe(grammar);
  });

  it("bounds the think block by the level's budget", () => {
    for (const level of ["low", "medium"] as const) {
      const tokens = LOCAL_CHAT_REASONING_BUDGET_TOKENS[level];
      expect(resolveStepGrammar({ reasoningBudgetTokens: tokens }, deps, [], false, false)).toBe(
        withReasoningBudget(grammar, reasoningBudgetChars(tokens)),
      );
    }
    expect(resolveStepGrammar({ reasoningBudgetTokens: LOCAL_CHAT_REASONING_BUDGET_TOKENS.low }, deps, [], false, false))
      .not.toBe(grammar);
  });

  it("High lifts the bound: the body the grammar reaches is unbounded", () => {
    // Our unbounded rewrite keeps any chained `think-body-N` lines defined
    // but unreferenced (harmless in GBNF), so the check is on what
    // `think-body` reaches, not on the bytes.
    const out = resolveStepGrammar({ reasoningBudgetTokens: LOCAL_CHAT_REASONING_BUDGET_TOKENS.high }, deps, [], false, false);
    expect(liveBodyChain(out)).toEqual(["think-body ::= think-char*"]);
    expect(out).toMatch(/^think-char ::= /m);
  });

  it("leaves thinking off and the forced final step as they were", () => {
    const low = LOCAL_CHAT_REASONING_BUDGET_TOKENS.low;
    expect(resolveStepGrammar({ reasoningBudgetTokens: low }, deps, [], true, false)).toBe(resolveStepGrammar({}, deps, [], true, false));
    expect(resolveStepGrammar({ reasoningBudgetTokens: low, terminalOnly: true }, deps, [], false, false)).toBe(
      resolveStepGrammar({ terminalOnly: true }, deps, [], false, false),
    );
  });
});
