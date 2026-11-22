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
const CLAUDE = { id: "claude-cli", kind: "subscription-cli", subscriptionCli: { cli: "claude" } };
const EMPTY_API = { id: "acme", kind: "openai-compatible", baseUrl: "https://acme.example/v1" };

function pane(provider, { providers = [provider], respond = async () => ({ ok: true, models: [] }), timers = { setTimeout, clearTimeout } } = {}) {
  const asked = [];
  const shown = [];
  const c = vm.createContext({
    LLMP: { models: [], modelsFor: null, modelsBusy: false, modelsErr: null, modelsStale: false, modelsRetry: null, filter: "", cursor: { cloud: 0 } },
    BR: { providerModels: async (id, kind, live) => { asked.push([id, kind, live]); return respond(id, kind); } },
    LLM_MODEL_WINDOW: 12,
    llmActiveTextId: () => provider.id, llmProvTabNow: () => "cloud", llmTabProviders: () => providers,
    llmProvider: (id) => providers.find((p) => p.id === id),
    closeSelector() { shown.push("closed"); },
    llmSetMode(mode) { shown.push(mode); },
    llmRepaint() {}, llmRepaintList() {}, llmClampCursors() {}, llmVisible: () => true,
    modelListFailLine: () => null, modelMatches: () => true, llmChatRow: (p, id) => ({ id }), llmRowHTML: (r) => "<row>" + r.id + "</row>",
    esc: (s) => String(s), ic: () => "", providerWord: (id) => id, ...timers,
  });
  for (const name of ["modelTierKey", "llmCloudSectionProvider", "llmModelProviderKind", "llmEnsureModels", "llmFetchModels",
    "llmRetryModels", "llmCloudSection", "llmProviderModelsHTML", "llmCloudModelListHTML",
    "llmOpenAddedSubscription"]) vm.runInContext(fn(name), c);
  return { c, asked, shown };
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

test("the Codex header fetches its own subscription models when a different cloud provider is active", async () => {
  const codex = { id: CODEX.id, subscriptionCli: { cli: "codex" } };
  const { c, asked, shown } = pane(EMPTY_API, { providers: [EMPTY_API, codex] });
  assert.equal(c.llmOpenAddedSubscription(CODEX), true);
  assert.deepEqual(shown, ["closed", "cloud"]);
  await c.llmEnsureModels();
  assert.deepEqual(asked, [[codex.id, "subscription-cli", true]]);
  const html = c.llmProviderModelsHTML("cloud", codex);
  assert.match(html, /Models on codex-cli/);
  assert.match(html, /Codex chooses its model itself, so there is nothing to pick here\./);
  assert.doesNotMatch(html, /Fetching the model list|No model matches/);
});

test("the Claude Code section shows its curated choices under its own header", async () => {
  const respond = async (id, kind) => ({ ok: true, models: kind === "subscription-cli" ? [{ id: "sonnet" }, { id: "opus" }] : [] });
  const { c, asked } = pane(EMPTY_API, { providers: [EMPTY_API, CLAUDE], respond });
  assert.equal(c.llmOpenAddedSubscription(CLAUDE), true);
  await c.llmEnsureModels();
  assert.deepEqual(asked, [[CLAUDE.id, "subscription-cli", true]]);
  const html = c.llmProviderModelsHTML("cloud", CLAUDE);
  assert.match(html, /Models on claude-cli/);
  assert.match(html, /<row>sonnet<\/row>.*<row>opus<\/row>/);
  assert.doesNotMatch(html, /Fetching the model list|No model matches|Codex chooses/);
});

test("a hung model-list request offers a retry for the same provider", async () => {
  let expire;
  let answerLate;
  let calls = 0;
  const timers = { setTimeout(callback) { expire = callback; }, clearTimeout() {} };
  const respond = () => calls++ === 0
    ? new Promise((resolve) => { answerLate = resolve; })
    : Promise.resolve({ ok: true, models: [] });
  const { c, asked } = pane(EMPTY_API, { providers: [EMPTY_API, CODEX], respond, timers });
  c.LLMP.modelsProviderId = CODEX.id;
  const requested = c.llmEnsureModels();
  const loading = c.llmProviderModelsHTML("cloud", CODEX);
  assert.match(loading, /Fetching the model list/);
  assert.doesNotMatch(loading, /No model matches/);
  assert.equal(typeof expire, "function", "the renderer must bound a pending bridge request");
  expire();
  await requested;
  const failed = c.llmProviderModelsHTML("cloud", CODEX);
  assert.match(failed, /Couldn’t fetch the model list/);
  assert.match(failed, /data-act="llm:modelsRetry">Try again/);
  assert.doesNotMatch(failed, /Fetching the model list|No model matches/);
  c.llmRetryModels();
  await settle();
  assert.deepEqual(asked, [[CODEX.id, "subscription-cli", true], [CODEX.id, "subscription-cli", true]]);
  answerLate({ ok: true, models: [{ id: "late-reply" }] });
  await settle();
  const ready = c.llmProviderModelsHTML("cloud", CODEX);
  assert.match(ready, /Codex chooses its model itself/);
  assert.doesNotMatch(ready, /late-reply|Try again/);
});
