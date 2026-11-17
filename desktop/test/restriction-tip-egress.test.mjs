// Review of issue #67, item 2: the "restricted to: …" chip's tooltip read
// the egress it allows from this window's config.json, and the agent's own
// answer (`channelsAllowed`) only when that failed. A remote agent has its
// own config, and a read taint is a stamp from when the file was read, so
// the list could say "channels" while the agent says no. The agent's answer
// is now always said; the config's list only when the agent runs on this
// computer and the list agrees with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../renderer/chat-restriction.js");

const FOLDER = "/work/client";
const info = (channelsAllowed, extra = {}) => ({
  known: true, channelsAllowed, ...extra,
  restriction: { label: "restricted to: local-llama", allowedProviders: ["local-llama"], folder: FOLDER, readFrom: [] },
});
const config = (egress) => ({ projects: { constraints: { [FOLDER]: { allowedProviders: ["local-llama"], allowedEgress: egress } } } });
const lines = (i, cfg) => R.restrictionTip(i, { config: cfg, rm: { effective: "local" }, word: (x) => x }).split("\n");

test("the agent's channelsAllowed is always said, beside a list that agrees with it", () => {
  assert.deepEqual(lines(info(false), config(["git"])).slice(2, 4),
    ["Allowed to leave this computer: git.", "Chat channels and phone push: not allowed."]);
  assert.deepEqual(lines(info(true), config(["channels"])).slice(2, 4),
    ["Allowed to leave this computer: channels.", "Chat channels and phone push: allowed."]);
});

test("a config list that contradicts the agent is not shown", () => {
  const l = lines(info(false), config(["channels", "git"]));
  assert.ok(!l.some((x) => x.startsWith("Allowed to leave")), l.join("|"));
  assert.ok(l.includes("Chat channels and phone push: not allowed."));
  assert.ok(!lines(info(true), config(["git"])).some((x) => x.startsWith("Allowed to leave")));
});

test("a remote agent's chat never shows this window's config list", () => {
  const l = lines(info(false, { remote: true }), config(["git"]));
  assert.ok(!l.some((x) => x.startsWith("Allowed to leave")), l.join("|"));
  assert.ok(l.includes("Chat channels and phone push: not allowed."));
});

test("main says whether the agent is remote beside its answer", async () => {
  const { readFileSync } = await import("node:fs");
  const live = readFileSync(new URL("../main/agent-live.ts", import.meta.url), "utf8");
  assert.match(live, /remote: client\.isRemote/);
});
