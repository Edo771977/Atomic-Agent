import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.C1E_CANDIDATE_ROOT) throw new Error("Set C1E_CANDIDATE_ROOT to the prepared review checkout");
const candidate = resolve(process.env.C1E_CANDIDATE_ROOT);
const state = mkdtempSync(join(tmpdir(), "c1e-review-"));
process.env.ATOMIC_AGENT_STATE_DIR = state;
after(() => rmSync(state, { recursive: true, force: true }));
const load = file => import(pathToFileURL(join(candidate, file)).href);
const { buildSubagentRunTool } = await load("src/tools/subagent/subagent-run.ts");
const { SubagentTurnLedger, SUBAGENT_MAX_CHILDREN_PER_TURN } = await load("src/tools/subagent/subagent-limits.ts");
const { createFusionWorkerSession } = await load("src/session/fusion-worker-session.ts");

function harness(over = {}) {
  const calls = [];
  const deps = {
    workingDir: state,
    createEphemeralSession: meta => createFusionWorkerSession({ workingDir: state, meta }),
    approvals: { setSessionPolicy() {}, clearSessionPolicy() {} },
    emitEvent() {},
    resolveRunMode: () => ({ effective: "cloud", workerMaxSteps: 6, workerTimeoutMs: 60000, cloudWorkers: 1 }),
    resolveSessionLeg: () => ({ providerId: "fixture-cloud", model: "fixture-model" }),
    workerSupportsSlotAffinity: () => false,
    approvalRequired: false,
    outputCharCap: 8000,
    isCloudProvider: () => true,
    runTurn: async (session, _message, options) => {
      calls.push({ session, options });
      options.eventHook?.({ type: "turn_started", turnIndex: 0 });
      options.eventHook?.({ type: "llm_event", event: { type: "llm_completed", completion: { usage: { promptTokens: 1000000, completionTokens: 0, totalTokens: 1000000 } } } });
      options.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: "Synthetic result" } });
      return { session, reason: "reply", stepCount: 1 };
    },
    ...over,
  };
  return { tool: buildSubagentRunTool(deps), calls };
}
const args = { tasks: [{ id: "fixture", instructions: "Return synthetic data; do not execute commands." }] };
const context = (over = {}) => ({ workingDir: state, sessionId: "s-parent", turnId: "turn-1", stepIndex: 1, signal: new AbortController().signal, ...over });

test("safety: a hard spend ceiling refuses a cloud leg whose cost cannot be accounted", async () => {
  let spent = 0;
  const h = harness({ resolveWorkerPricing: () => undefined });
  const result = await h.tool.run(args, context({ turnSpend: { ceilingUsd: 1, spentUsd: () => spent, add: usd => { spent += usd; } } }));
  assert.equal(h.calls.length, 0, "an unpriced paid worker must not start under a hard cap");
  assert.equal(result.status, "error");
});

test("safety: other sessions cannot evict an active turn's hard child count", () => {
  const ledger = new SubagentTurnLedger();
  const at = { turnId: "active-turn", stepIndex: 1 };
  ledger.record("s-active", at, SUBAGENT_MAX_CHILDREN_PER_TURN);
  for (let i = 0; i < 256; i++) ledger.record(`s-other-${i}`, { turnId: `turn-${i}`, stepIndex: 1 }, 1);
  assert.equal(ledger.childrenThisTurn("s-active", { ...at, stepIndex: 2 }), SUBAGENT_MAX_CHILDREN_PER_TURN);
});

test("control: a reached spend ceiling prevents dispatch", async () => {
  const h = harness();
  const result = await h.tool.run(args, context({ turnSpend: { ceilingUsd: 1, spentUsd: () => 1, add() { assert.fail("no accounting after refusal"); } } }));
  assert.equal(h.calls.length, 0);
  assert.equal(result.details.reason, "cost-ceiling");
});

test("control: worker ids remain unable to launch nested subagents", async () => {
  const h = harness();
  const result = await h.tool.run(args, context({ sessionId: "s-w-existing" }));
  assert.equal(h.calls.length, 0);
  assert.equal(result.details.reason, "depth");
});

test("control: usage of a priced worker reaches the parent spend seam", async () => {
  let spent = 0;
  const h = harness({ resolveWorkerPricing: () => ({ input: 1, output: 1 }) });
  await h.tool.run(args, context({ turnSpend: { ceilingUsd: 10, spentUsd: () => spent, add: usd => { spent += usd; } } }));
  assert.equal(h.calls.length, 1);
  assert.equal(spent, 1);
});
