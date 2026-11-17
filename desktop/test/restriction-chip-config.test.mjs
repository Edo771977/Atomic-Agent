// Review of issue #67, item 4: the "restricted to: …" chip was asked only
// when a chat was opened and when its turn ended, so a constraint edited or
// removed in config.json left the old chip until then. Each config read
// (refreshLiveConfig, after every write) now asks again when
// `projects.constraints` changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const KEY = "/work/client";
const RESTRICTED = { known: true, channelsAllowed: false, remote: false, status: 200,
  restriction: { label: "restricted to: local-llama", allowedProviders: ["local-llama"], folder: KEY, readFrom: [] } };
const FREE = { known: true, channelsAllowed: true, remote: false, status: 200, restriction: null };

function windowWith(answers) {
  const asked = [];
  const c = vm.createContext({
    S: { sessionId: "s-1", agentSession: "s-1" }, esc: (s) => String(s), ic: () => "", providerWord: (x) => x,
    rmNow: () => ({ effective: "local" }), document: { querySelector: () => null }, setTimeout,
    BR: { providerRestriction: async (sid) => { asked.push(sid); return answers.shift(); } },
  });
  vm.runInContext(src("../renderer/chat-restriction.js"), c);
  return { c, asked };
}
const cfg = (constraints) => ({ projects: { constraints } });

test("a constraint removed from the config takes the chip away", async () => {
  const { c, asked } = windowWith([RESTRICTED, FREE]);
  await c.restrictionRefresh("s-1");
  assert.match(c.restrictionChipHTML(), /restricted to: local-llama/);
  await c.restrictionConfigChanged(cfg({ [KEY]: { allowedProviders: ["local-llama"] } }), cfg({}));
  assert.equal(asked.length, 2);
  assert.equal(c.restrictionChipHTML(), "");
});

test("a config read that leaves the constraints as they were asks nothing", async () => {
  const { c, asked } = windowWith([RESTRICTED]);
  await c.restrictionRefresh("s-1");
  const same = cfg({ [KEY]: { allowedProviders: ["local-llama"] } });
  await c.restrictionConfigChanged(same, JSON.parse(JSON.stringify(same)));
  assert.equal(asked.length, 1);
});

test("refreshLiveConfig tells it, with the config before and after", () => {
  const r = src("../renderer/renderer.js");
  const body = r.slice(r.indexOf("async function refreshLiveConfig("), r.indexOf("async function refreshLiveConfig(") + 1500);
  assert.match(body, /const cfgWas = LIVE_CONFIG;/);
  assert.match(body, /restrictionConfigChanged\(cfgWas, LIVE_CONFIG\)/);
});
