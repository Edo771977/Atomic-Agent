// Review of issue #67, item 5: a new project chat's stand-in row (its first
// turn running, no session named yet) did nothing when clicked after the
// person had moved to another chat. It now brings that chat back: the turn
// this window keeps for it (LIVE_TURNS, item 38) is the window's again, its
// rows on screen with what came meanwhile, as openSession does for a chat
// whose turn runs here. Clicked while the new chat is still on screen, it
// only shows it. The renderer's functions in a vm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const renderer = src("../renderer/renderer.js");
function fn(name) {
  let at = renderer.indexOf("\nfunction " + name + "(");
  if (at < 0) at = renderer.indexOf("\nasync function " + name + "(");
  if (at < 0) throw new Error("no function " + name);
  return renderer.slice(at + 1, renderer.indexOf("\n}\n", at) + 2);
}

function window() {
  const drawn = [];
  const calls = [];
  const c = vm.createContext({
    S: { room: "chat", sessionId: "s-other", agentSession: "s-other", turnId: "t-other", log: [], busy: false, history: [] },
    LIVE_TURNS: new Map(), RUNNING: new Map(), FZ: { live: [] }, PLAN: {}, WAIT: null, WAIT_TICK: 0, LIVE_REPLAY: false, LOGS: [],
    OPEN_SEQ: 0, render: () => calls.push("render"), stashQueue: () => calls.push("stash"), restoreQueue: (k) => calls.push("restore:" + k),
    liveLeave: () => calls.push("leave"), clearPlanOffer: () => {}, forgetApprovalCard: () => {}, dropChatToasts: () => {},
    onChatEvent: (f) => drawn.push(f.kind + ":" + (f.text || "")), llamaSlotsRefresh: () => {}, tpFzEnsureTick: () => {},
    refreshWaitStrip: () => {}, nid: (() => { let n = 0; return () => "n" + ++n; })(), setInterval, clearInterval,
  });
  for (const n of ["liveSegment", "liveReasonId", "liveSetWait", "liveRebuild", "liveReplay", "liveReplayFrames", "projectStandInShow"]) {
    vm.runInContext(fn(n), c);
  }
  return { c, drawn, calls };
}

function keptTurn(c) {
  const asked = { id: "a1", k: "user", text: "Plan the release" };
  const item = { id: "r1", k: "assistant", text: "Working" };
  const rec = { text: "Plan the release", asked, item, log: [asked, item], startedAt: 1, planMode: null, view: { wait: null, fz: [] },
    missed: [{ turnId: "t1", kind: "delta", text: " on it", at: 2 }], steers: [], ended: null, sid: null };
  c.LIVE_TURNS.set("t1", rec);
  c.RUNNING.set("t1", null);
  return rec;
}

test("clicked after moving to another chat, the stand-in brings its running turn back on screen", () => {
  const { c, drawn, calls } = window();
  const rec = keptTurn(c);
  assert.equal(c.projectStandInShow({ turnId: "t1", pid: "pabc1234" }), true);
  assert.equal(c.S.turnId, "t1");
  assert.equal(c.S.agentSession, null);
  assert.equal(c.S.sessionId, "");
  assert.equal(c.S.busy, true);
  assert.deepEqual(JSON.parse(JSON.stringify(c.S.log.map((m) => m.id))), ["a1", "r1"]);
  assert.equal(c.S.streamId, "r1");
  assert.equal(rec.log, c.S.log);
  assert.deepEqual(drawn, ["delta: on it"], "what came meanwhile is drawn into it");
  assert.deepEqual(calls.slice(0, 2), ["stash", "leave"]);
  assert.ok(calls.includes("restore:turn:t1"));
});

test("clicked while that new chat is on screen, it only shows it; an ended or unknown turn does nothing", () => {
  const { c, drawn } = window();
  const rec = keptTurn(c);
  c.S.turnId = "t1"; c.S.agentSession = null; c.S.sessionId = ""; c.S.log = rec.log; c.S.room = "studio";
  assert.equal(c.projectStandInShow({ turnId: "t1" }), true);
  assert.equal(c.S.room, "chat");
  assert.deepEqual(drawn, []);
  rec.ended = { kind: "error" };
  const before = c.S.log;
  assert.equal(c.projectStandInShow({ turnId: "t1" }), false);
  assert.equal(c.projectStandInShow({ turnId: "nope" }), false);
  assert.equal(c.S.log, before);
});

test("openSession hands a stand-in's id to it", () => {
  assert.match(fn("openSession"), /const standIn = projectStandIn\(id\);\n\s*if \(standIn\) \{ projectStandInShow\(standIn\); return; \}/);
});
