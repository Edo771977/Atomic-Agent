// Issue #67 (1): a chat whose folder is restricted by `projects.constraints`
// (or that read files inside one) showed nothing in the desktop, while the
// TUI composer shows "restricted to: <providers>". In Fusion the chat then
// ran on the local leg only with no word of why. The composer now draws a
// "restricted to: …" chip after the route, from the agent's
// GET /api/sessions/{id}/provider-restriction (main/provider-restriction.ts
// reads the answer; renderer/chat-restriction.js draws it), with a tooltip:
// why, the providers and the egress allowed, and what Fusion does. It is
// asked when the chat is opened and when each of its turns ends; an older
// agent, an error or an unrestricted chat draws no chip.
// Run: npm run build first (the main half is read from out/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const M = require("../out/main/provider-restriction.js");
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const R = require("../renderer/chat-restriction.js");

const FOLDER = "C:\\Users\\me\\Downloads\\riservata";
const RESTRICTED = {
  status: 200,
  body: { restriction: { label: "restricted to: local-llama", allowedProviders: ["local-llama"], folder: FOLDER, readFrom: [] }, channelsAllowed: false },
};

test("main reads the agent's answer: a restriction, none, or nothing known", () => {
  assert.deepEqual(M.readProviderRestriction(RESTRICTED), {
    known: true,
    restriction: { label: "restricted to: local-llama", allowedProviders: ["local-llama"], folder: FOLDER, readFrom: [] },
    channelsAllowed: false,
  });
  assert.deepEqual(M.readProviderRestriction({ status: 200, body: { restriction: null, channelsAllowed: true } }),
    { known: true, restriction: null, channelsAllowed: true });
  // An agent without the route (or a chat it has not stored yet): 404. No answer, an error, a body of another shape.
  for (const answer of [null, { status: 404, body: { error: { message: "not found" } } }, { status: 500, body: null },
    { status: 200, body: { something: 1 } }, { status: 200, body: { restriction: { label: 3 } } }]) {
    assert.deepEqual(M.readProviderRestriction(answer), { known: false, restriction: null, channelsAllowed: null }, JSON.stringify(answer));
  }
  // An agent from before `channelsAllowed`.
  assert.equal(M.readProviderRestriction({ status: 200, body: { restriction: RESTRICTED.body.restriction } }).channelsAllowed, null);
});

const word = (id) => ({ "local-llama": "Local models", anthropic: "Anthropic" }[id] || id);
const CONFIG = { projects: { constraints: { [FOLDER]: { allowedProviders: ["local-llama"], allowedEgress: ["git"] } } } };

test("the chip says what the agent says, and the tooltip why, what may be used, and Fusion", () => {
  const info = M.readProviderRestriction(RESTRICTED);
  assert.equal(R.restrictionChipLabel(info), "restricted to: local-llama");
  const tip = R.restrictionTip(info, { config: CONFIG, rm: { effective: "cloud" }, word });
  assert.equal(tip, [
    `This chat's folder (${FOLDER}) is restricted in projects.constraints.`,
    "Providers allowed: Local models.",
    "Allowed to leave this computer: git.",
    "In Fusion, only the side these providers allow would run.",
  ].join("\n"));
});

test("a chat that read files inside a restricted folder says so; egress it cannot read comes from channelsAllowed", () => {
  const info = M.readProviderRestriction({ status: 200, body: {
    restriction: { label: "restricted to: local-llama", allowedProviders: ["local-llama"], folder: "/w/secret", readFrom: ["/w/secret"] },
    channelsAllowed: false } });
  const tip = R.restrictionTip(info, { config: {}, rm: { effective: "local" }, word }).split("\n");
  assert.equal(tip[0], "This chat read files from /w/secret, which is restricted in projects.constraints.");
  assert.equal(tip[2], "Chat channels and phone push: not allowed.");
});

test("in Fusion the tooltip says which side runs", () => {
  const info = M.readProviderRestriction(RESTRICTED);
  const fz = (orch, worker) => R.restrictionTip(info, { config: CONFIG, word,
    rm: { effective: "fusion", orchestratorProviderId: orch, workerProviderId: worker, primaryProviderId: orch } }).split("\n").pop();
  assert.equal(fz("anthropic", "local-llama"), "Fusion: only the workers' model (Local models) runs, on its own.");
  assert.equal(fz("local-llama", "anthropic"), "Fusion: the orchestrator (Local models) works alone, without workers.");
  assert.equal(fz("anthropic", "openrouter"), "Fusion: neither side is allowed, so the turn runs on an allowed provider if there is one.");
  assert.equal(fz("local-llama", "local-llama"), "Fusion: both sides are allowed.");
});

/* The window half in a vm: the answer for the chat on screen is drawn, one
   for a chat left since is not, and no answer draws nothing. */
function windowWith(answers) {
  const asked = [];
  const c = vm.createContext({
    S: { sessionId: "s-1" }, LIVE_CONFIG: CONFIG, esc: (s) => String(s), ic: () => "", providerWord: word,
    rmNow: () => ({ effective: "local" }), document: { querySelector: () => null }, setTimeout,
    BR: { providerRestriction: async (sid) => { asked.push(sid); return answers[sid]; } },
  });
  vm.runInContext(src("../renderer/chat-restriction.js"), c);
  return { c, asked };
}

test("the chip is drawn for the chat on screen once its answer lands, and not for an older agent", async () => {
  const known = M.readProviderRestriction(RESTRICTED);
  const { c, asked } = windowWith({ "s-1": known, "s-2": { known: false, restriction: null, channelsAllowed: null } });
  assert.equal(c.restrictionChipHTML(), "");
  await c.restrictionRefresh("s-1");
  assert.deepEqual(asked, ["s-1"]);
  const html = c.restrictionChipHTML();
  assert.match(html, /class="cchip restrictchip"/);
  assert.match(html, /restricted to: local-llama/);
  assert.match(html, /title="This chat's folder/);
  c.S.sessionId = "s-2";
  assert.equal(c.restrictionChipHTML(), "", "another chat does not wear it");
  await c.restrictionRefresh("s-2");
  assert.equal(c.restrictionChipHTML(), "");
  // An answer that lands after the chat was left is not drawn for the next one.
  c.S.sessionId = "s-3";
  await c.restrictionRefresh("s-1");
  assert.equal(c.restrictionChipHTML(), "");
  // No session yet (a new chat before its first turn) asks nothing.
  c.S.sessionId = null;
  await c.restrictionRefresh(null);
  assert.equal(asked.includes(null), false);
});

test("the window asks when a chat is opened and when its turn ends; the bridge and the composer carry it", () => {
  const r = src("../renderer/renderer.js");
  const open = r.slice(r.indexOf("async function openSession("), r.indexOf("async function openSession(") + 6000);
  assert.match(open, /restrictionRefresh\(id\)/);
  const end = r.slice(r.indexOf("if (ev.kind === 'done' || ev.kind === 'aborted' || ev.kind === 'error') {\n      const sid = RUNNING.get(ev.turnId);"));
  assert.match(end.slice(0, 1500), /restrictionRefresh\(sid\)/);
  assert.match(r, /routeChipsHtml\(backend\)\)\n\s*\+ restrictionChipHTML\(\)/);
  const html = src("../renderer/index.html");
  assert.ok(html.indexOf('src="chat-restriction.js"') > 0 && html.indexOf('src="chat-restriction.js"') < html.indexOf('src="renderer.js"'));
  assert.match(src("../preload/preload.ts"), /providerRestriction: \(sessionId: string\) => ipcRenderer\.invoke\("agent:providerRestriction", sessionId\)/);
  assert.match(src("../main/agent-live.ts"), /ipcMain\.handle\("agent:providerRestriction"/);
});
