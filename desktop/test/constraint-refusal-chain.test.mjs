// Review of issue #67, item 1: a fallback chain whose picked provider the
// folder refuses (anthropic) and whose LAST link then fails for another
// reason. The agent's frame tells the first link's story (its words, its
// constraint `code` and `advice`), lists the links before the last in
// `fallback_failures`, and, when the last link was the managed local model
// with its engine gone, says so in its verdict (`failure.cause:
// "local_engine_down"`, src/http/openai-chat-completions.ts loop_failed). The
// row read "Turn stopped. … /runmode local" with no Start model. Now an
// engine-down ending is the dead-engine row (Start model), and any other
// ending after the refusal says the fallback failed too, beside the list.
// The renderer's rows as liveFailureRows builds them, in a vm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const source = src("../renderer/renderer.js");
function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  if (at < 0) return "";
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}
const NAMES = [
  "providerHost", "providerFailure", "providerReplied", "turnWaited", "turnFailure", "turnFailureLine", "offlineTurnLine",
  "constraintTurnLine", "constraintRefusalWords", "constraintFolderWords", "localWrongServerLine", "localContextFullLine", "localRequestInvalidLine", "localFailureCode",
  "localFrameAdvice", "localServerHost", "waitIsLocalServer", "selProviders", "selActiveProviderId", "llmBlock",
  "llmProviders", "llmProvider", "llmLocalModels", "deadEngineRow", "turnFailureAct", "turnKeyRejected",
];
const CONFIG = {
  localModels: { mode: "managed", managed: { port: 19091 } },
  llm: { activeTextProvider: "anthropic", providers: [{ id: "anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com" }] },
};
function row(ev) {
  const c = vm.createContext({
    LIVE_CONFIG: CONFIG, S: { turnStartedAt: 0 }, SWX: {}, projectTurnModel: () => null, URL,
    esc: (s) => String(s), providerWord: (id) => (id === "anthropic" ? "Anthropic" : String(id)),
    savedKeyInvalid: () => false, billingFailureLine: () => "",
  });
  vm.runInContext(src("../renderer/dead-engine.js"), c);
  for (const n of NAMES) { const s = fn(n); if (s) vm.runInContext(s, c); }
  return { ...c.turnFailure(ev), ...c.turnFailureAct(ev), ...c.deadEngineRow(ev) };
}

const FOLDER = "C:\\Users\\me\\Downloads\\riservata";
const REFUSED = `folder ${FOLDER} is restricted to: local-llama; provider "anthropic" may not serve the main model, nothing was sent`;
const ADVICE = "This folder is restricted to: local-llama. The main model can't use anthropic here. — switch to local with ctrl+r or /runmode local";
const chain = (failure) => {
  const frame = {
    error: REFUSED, category: "transport", failure,
    code: "ATOMIC_AGENT_PROVIDER_NOT_ALLOWED", advice: ADVICE,
    fallback_failures: [{ providerId: "anthropic", reason: REFUSED }],
  };
  return { kind: "error", error: frame.error, category: frame.category, payload: frame };
};

test("a refused pick whose local fallback's engine is down reads as the dead engine, with Start model", () => {
  const r = row(chain({ cause: "local_engine_down", phrase: "The local model isn't running.", action: "start-model" }));
  assert.equal(r.text, "The local model isn't running.");
  assert.equal(r.act, "start-model");
});

test("any other ending after the refusal keeps the refusal and says the fallback failed too", () => {
  const r = row(chain({ cause: "network_unreachable", phrase: "x", action: "retry" }));
  assert.equal(r.text, "Turn stopped. This folder is restricted to: local-llama. The main model can't use anthropic here. — switch to local with /runmode local"
    + " The fallback after it failed too (Providers tried).");
  assert.doesNotMatch(r.text, /not answering/);
});

test("a single refused link reads as before", () => {
  const ev = chain({ cause: "unknown" });
  delete ev.payload.fallback_failures;
  assert.match(row(ev).text, /^Turn stopped\. This folder is restricted to: local-llama\. The main model can't use anthropic here\. — switch to local with \/runmode local$/);
});
