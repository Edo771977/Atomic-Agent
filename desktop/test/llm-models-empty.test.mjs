// Settings › Models: a provider that answers an empty model list (Codex on a
// subscription resolves its model itself, so main answers {ok: true, models: []}
// on purpose) was taken as never asked, so every repaint asked again and
// "Fetching the model list…" spun forever. renderer.js's own functions are run
// with their collaborators stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
function fn(name) {
  let at = source.indexOf("\nfunction " + name + "(");
  if (at < 0) at = source.indexOf("\nasync function " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}

const CODEX = { id: "codex-cli", kind: "subscription-cli", subscriptionCli: "codex" };
const EMPTY_API = { id: "acme", kind: "openai-compatible", baseUrl: "https://acme.example/v1" };

function pane(provider) {
  const asked = [];
  const c = vm.createContext({
    LLMP: { models: [], modelsFor: null, modelsBusy: false, modelsErr: null, modelsStale: false, modelsRetry: null, filter: "", cursor: { cloud: 0 } },
    BR: { providerModels: async (id, kind, live) => { asked.push([id, kind, live]); return { ok: true, models: [] }; } },
    LLM_MODEL_WINDOW: 12,
    llmCloudSectionProvider: () => provider, llmProvTabNow: () => "cloud", llmTabProviders: () => [provider],
    llmRepaint() {}, llmRepaintList() {}, llmClampCursors() {}, llmVisible: () => true,
    modelListFailLine: () => null, modelMatches: () => true, llmChatRow: (p, id) => ({ id }), llmRowHTML: (r) => "<row>" + r.id + "</row>",
    esc: (s) => String(s), ic: () => "", providerWord: (id) => id, setTimeout, clearTimeout,
  });
  for (const name of ["modelTierKey", "llmEnsureModels", "llmFetchModels", "llmRetryModels", "llmCloudSection", "llmCloudModelListHTML"]) vm.runInContext(fn(name), c);
  return { c, asked };
}
const settle = () => new Promise((r) => setImmediate(r));

for (const [label, provider] of [["Codex on a subscription", CODEX], ["an API provider with no models", EMPTY_API]]) {
  test(`an empty model list from ${label} is asked once and stops loading`, async () => {
    const { c, asked } = pane(provider);
    for (let i = 0; i < 4; i++) { await c.llmEnsureModels(); await settle(); }   // each repaint asks
    assert.equal(asked.length, 1, "the empty list was asked again on every repaint");
    const html = c.llmCloudModelListHTML("cloud");
    assert.doesNotMatch(html, /Fetching the model list/);
    if (provider === CODEX) {
      assert.match(html, /Codex chooses its model itself, so there is nothing to pick here\./);
      assert.doesNotMatch(html, /No model matches/);
    } else {
      assert.match(html, /No model matches\./);
    }
    // Retry asks again; a provider change asks for the new one.
    c.llmRetryModels(); await settle();
    assert.equal(asked.length, 2);
  });
}
