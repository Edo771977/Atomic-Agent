// Issue #74 (16): the "restricted to: …" chip (chat-restriction.js RESTRICT,
// PROV) and the Reviewer seat (fusion-reviewer.js FZRV.roster, FZRV.asked)
// kept the answers of the agent that gave them after the agent restarted or
// the window switched to a remote agent, unlike the project trust, approval
// rules, offline mode or webhooks state (renderer.js PT_GEN and the like):
// a remote agent's chat wore this computer's restriction, and the seat
// listed the old agent's reviewers. Both are now gated on AGENT_GEN: a new
// agent drops them and asks again for the chat on screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const RESTRICTED = { known: true, channelsAllowed: false, remote: false, status: 200,
  restriction: { label: "restricted to: local-llama", allowedProviders: ["local-llama"], folder: "/w", readFrom: [] } };
const UNRESTRICTED = { known: true, channelsAllowed: true, remote: true, status: 200, restriction: null };

function restrictionWindow(answers) {
  const asked = [];
  const c = vm.createContext({
    S: { sessionId: "s-1", agentSession: "s-1" }, AGENT_GEN: 1, PENDING_GRACE_MS: 5, LIVE_CONFIG: {},
    esc: (s) => String(s), ic: () => "", providerWord: (x) => x, rmNow: () => ({ effective: "local" }),
    document: { querySelector: () => null }, setTimeout, workingDir: () => "/w", projectMarkedInfo: () => null,
  });
  c.BR = { providerRestriction: async (sid) => { asked.push(sid); return answers.shift(); }, folderConstraint: async () => ({ known: false }) };
  vm.runInContext(src("../renderer/chat-restriction.js"), c);
  return { c, asked };
}

test("the restriction chip drops the old agent's answer and asks the new one", async () => {
  const { c, asked } = restrictionWindow([RESTRICTED, UNRESTRICTED]);
  await c.restrictionRefresh("s-1");
  assert.match(c.restrictionChipHTML(), /restricted to: local-llama/);
  // The agent restarts, or the window switches to a remote agent: a new generation.
  c.AGENT_GEN = 2;
  assert.equal(c.restrictionChipHTML(), "", "the old agent's restriction is still drawn");
  await wait();
  assert.deepEqual([...asked], ["s-1", "s-1"]);
  assert.equal(c.restrictionChipHTML(), "");
});

test("an answer of the old agent landing after the new one connected is not drawn", async () => {
  let release;
  const { c } = restrictionWindow([]);
  c.BR.providerRestriction = () => new Promise((r) => { release = r; });
  const pending = c.restrictionRefresh("s-1");
  c.AGENT_GEN = 2;
  c.BR.providerRestriction = async () => UNRESTRICTED;
  c.restrictionAgentChanged();
  release(RESTRICTED);
  await pending; await wait();
  assert.equal(c.restrictionChipHTML(), "");
});

function seatWindow() {
  const asked = [];
  const ctx = {
    S: { agentSession: "s1", sessionId: "s1", overlay: null }, AGENT_GEN: 1, LIVE_CONFIG: { llm: { providers: [] } },
    esc: (s) => String(s), ic: () => "", providerWord: (x) => x, render: () => {}, toast: () => {}, document: undefined,
  };
  let roster = { known: true, configured: true, reviewers: [{ ref: "codex-cli:default", usable: true }], chat: { reviewer: "codex-cli:default" } };
  ctx.BR = { fusionTeam: async (sid) => { asked.push(sid); return roster; } };
  vm.runInNewContext(src("../renderer/fusion-reviewer.js"), ctx);
  return { c: ctx, asked, set: (r) => { roster = r; } };
}

test("the Reviewer seat drops the old agent's team and asks the new one", async () => {
  const { c, asked, set } = seatWindow();
  await c.fzrRefresh("s1");
  assert.match(c.fzrSeatHTML(), /codex-cli/);
  // A remote agent with no team route.
  set({ known: false });
  c.AGENT_GEN = 2;
  c.fzrAgentChanged && c.fzrAgentChanged();
  assert.doesNotMatch(c.fzrSeatHTML(), /codex-cli/, "the old agent's reviewer is still on the seat");
  await wait();
  assert.deepEqual([...asked], ["s1", "s1"]);
  assert.equal(c.fzrSeatHTML(), "");
});
