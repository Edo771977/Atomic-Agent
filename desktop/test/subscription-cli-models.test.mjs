// ATO-844: main's model list for a subscription-CLI provider, against the
// built output, and the copy of the agent's Claude list it keeps.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const m = require("../out/main/subscription-cli-models.js");
const { providerModels, withCliStandIn } = require("../out/main/agent-cli.js");

const config = { llm: { providers: [
  { id: "codex-work", kind: "subscription-cli", subscriptionCli: { cli: "codex" } },
  { id: "claude-work", kind: "subscription-cli", subscriptionCli: { cli: "claude" } },
  { id: "api-work", kind: "openai-compatible" },
] } };
const hooks = { configHint: () => config };

const core = readFileSync(new URL("../../src/llm/provider/subscription-cli/claude-cli-models.ts", import.meta.url), "utf8");
function coreList(name) {
  const at = core.indexOf("export const " + name);
  assert.ok(at >= 0, name);
  const body = core.slice(core.indexOf("[", at), core.indexOf("]", at));
  return [...body.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

test("the Claude list is the agent's, aliases first, and so is the default", () => {
  assert.deepEqual([...m.CLAUDE_CLI_CHAT_MODELS], [...coreList("CLAUDE_CLI_MODEL_ALIASES"), ...coreList("CLAUDE_CLI_MODEL_IDS")]);
  assert.match(core, new RegExp(`CLAUDE_CLI_DEFAULT_CHAT_MODEL = "${m.CLAUDE_CLI_DEFAULT_CHAT_MODEL}"`));
});

test("a Claude entry lists its pinned model first, then the built-in list, once each", () => {
  const ids = m.subscriptionCliModels({ id: "claude-cli", kind: "subscription-cli", defaultChatModel: "claude-opus-5", subscriptionCli: { cli: "claude" } });
  assert.equal(ids[0].id, "claude-opus-5");
  assert.equal(ids[0].provider, "claude-cli");
  assert.equal(new Set(ids.map((x) => x.id)).size, ids.length);
  assert.equal(ids.length, m.CLAUDE_CLI_CHAT_MODELS.length);
});

test("a Codex entry lists only what it pinned, and nothing when it pinned nothing", () => {
  assert.deepEqual(m.subscriptionCliModels({ id: "codex-cli", kind: "subscription-cli", subscriptionCli: { cli: "codex" } }), []);
  assert.deepEqual(m.subscriptionCliModels({ id: "codex-cli", kind: "subscription-cli", defaultChatModel: "gpt-5-codex", subscriptionCli: { cli: "codex" } }),
    [{ provider: "codex-cli", id: "gpt-5-codex" }]);
});

test("main answers the saved subscription's list locally even with a missing or incorrect caller kind", async () => {
  const noSearch = async () => assert.fail("the provider has no HTTP endpoint");
  await withCliStandIn(noSearch, async () => {
    assert.deepEqual(await providerModels("codex-work", "", { live: true }), { ok: true, models: [] });
    const claude = await providerModels("claude-work", "openai-compatible", { live: true });
    assert.equal(claude.ok, true);
    assert.deepEqual(claude.models.map((model) => model.id), m.CLAUDE_CLI_CHAT_MODELS);
  }, hooks);
});

test("a saved API provider uses its own catalogue when the caller names the subscription kind", async () => {
  const models = [{ provider: "api-work", id: "api-model" }];
  const search = async (args) => {
    assert.deepEqual(args.slice(0, 5), ["models", "search", " ", "--provider", "api-work"]);
    assert.ok(args.includes("--refresh"));
    return { ok: true, stdout: JSON.stringify(models), stderr: "" };
  };
  const result = await withCliStandIn(search, () => providerModels("api-work", "subscription-cli", { live: true }), hooks);
  assert.deepEqual(result, { ok: true, models });
});
