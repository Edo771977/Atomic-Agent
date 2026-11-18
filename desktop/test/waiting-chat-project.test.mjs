// Issue #74 (15): a new chat's first message sent while the model switches
// is queued under a `waiting-<uuid>` id, and its turn went out with that id
// as the chat's session. startLiveTurn then skipped projectForNewTurn() and
// the Reviewer seat's new-chat slot, so a chat opened in a project ran in the
// window's folder without the project's instructions or constraint (main's
// turnProject reads a known session's project by its id), and its reviewer
// pick leaked to the next new chat. Now both are the waiting chat's when the
// message is queued: the chat is filed in the project then (the turn waits
// for that), and the pick is keyed by its id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const ts = createRequire(import.meta.url)("typescript");
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const source = src("../renderer/renderer.js");
const ast = ts.createSourceFile("renderer.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map((n) => [n.name.text, n.getText(ast)]));

const STORE = { id: "pris1234", name: "Riservata", folder: "/home/me/riservata", instructions: "be careful", createdAt: 1 };

function fixture() {
  const calls = [];
  let id = 0;
  const c = vm.createContext({
    S: { draft: "hello", queued: [], busy: false, pending: null, sessionId: "", agentSession: null, log: [], live: { state: "connected" }, overlay: null },
    SWX: { pending: 1, want: { model: "new" } }, BSW: { gating: false }, VOICE: { state: "idle" }, OPENING: null, PLAN: {}, MODE: { known: false }, FZ: {},
    DRAIN_OWED: false, STEER: { ahead: 0 }, MAX_QUEUED: 20, QUEUES: new Map(), PENDING_CHATS: new Map(), RUNNING: new Map(), SESSIONS: [],
    FIRST_TURNS: new Map(), LIVE_TURNS: new Map(), PENDING_GRACE_MS: 5000,
    crypto: { randomUUID: () => String(++id) }, $: () => null, ctxDraftChanged() {}, render() {}, renderSidebar() {}, clearInterval() {},
    toast: () => {}, localTurnGate: () => ({ kind: "run" }), nid: () => "n" + ++id, esc: (s) => String(s), ic: () => "", console,
    bswSnapshot: async () => {}, clearPlanOffer() {}, dropStaleGateNotices() {}, pushHistory() {}, liveSetWait() {},
    liveAskedRow: () => null, livePriorAsks: () => [], liveShowsTurn: () => false, projectStandInNote() {},
    liveTurnStarted: (turnId, live) => calls.push(["live", turnId, live.folder]),
    reasoningTurnLevel: () => undefined, workingDir: () => "/home/me/window", isAbsPath: () => true, providerWord: (x) => x,
    document: undefined, localStorage: undefined, ticker: null, attForgetMessage() {},
  });
  c.projectTurnModel = (sid, pid) => { calls.push(["model", sid ?? null, pid ?? null]); return null; };
  c.BR = {
    projectsList: async () => ({ ok: true, data: { projects: [STORE], chats: {} } }), projectsSave: async () => ({ ok: true }),
    projectsAssign: async (p) => { calls.push(["assign", p.sessionId, p.projectId]); await new Promise((r) => setTimeout(r, 5)); calls.push(["assigned"]); return { ok: true }; },
    chat: async (msgs, session, project, level, model, team) => {
      calls.push(["chat", session ?? null, project ?? null, team ? team.reviewer : null]);
      return { ok: true, turnId: "t" + ++id };
    },
    fusionTeam: async () => ({ known: true, configured: true, reviewers: [{ ref: "codex-cli:default", usable: true }], chat: { reviewer: null } }),
  };
  vm.runInContext(src("../renderer/attachments.js"), c);
  for (const f of ["chat-list.js", "chat-folders.js", "chat-projects.js", "fusion-reviewer.js"]) vm.runInContext(src("../renderer/" + f), c);
  vm.runInContext("PROJECTS.state = {projects: [" + JSON.stringify(STORE) + "], chats: {}};", c);
  for (const name of ["chatTitle", "submit", "swxWaitsForRoute", "openHoldsComposer", "noteWaitingChat", "drainQueued", "drainOwed",
    "queueKey", "startLiveTurn", "firstTurnFolder", "firstTurnSent", "projectNoteTurn", "unqueueMessage", "queueChatRunning"]) {
    const fn = functions.get(name);
    if (fn) vm.runInContext(fn, c);
  }
  return { c, calls };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

test("a new chat's first message queued during a switch keeps its project and its Reviewer pick", async () => {
  const { c, calls } = fixture();
  // New chat in the project (its + on the sidebar), a reviewer picked in its seat.
  vm.runInContext("PROJECTS.newFor = {id: 'pris1234', log: S.log};", c);
  await c.fzrAct("pick:codex-cli:default");
  c.submit();
  const sid = c.S.sessionId;
  assert.match(sid, /^waiting-/);
  // The switch ends: the queued message goes out.
  c.SWX.pending = 0;
  c.drainOwed();
  await settle();
  const chat = calls.find((x) => x[0] === "chat");
  assert.ok(chat, "the turn went out");
  // Filed in the project before the turn, so main opens it in the project's folder with its instructions.
  assert.deepEqual(calls.filter((x) => x[0] !== "model" && x[0] !== "live").map((x) => x.map(String).join(" ")),
    ["assign " + sid + " pris1234", "assigned", "chat " + sid + " null codex-cli:default"]);
  assert.deepEqual(calls.find((x) => x[0] === "model"), ["model", null, "pris1234"], "the project's model");
  assert.equal(calls.find((x) => x[0] === "live")[2], STORE.folder, "the folder the turn runs in");
  // The next new chat starts from the team's choice, not this one's pick.
  assert.equal(c.fzrTurnTeam(undefined), null);
});

test("a queued new chat with no project goes out at once, as before", async () => {
  const { c, calls } = fixture();
  c.submit();
  const sid = c.S.sessionId;
  c.SWX.pending = 0;
  c.drainOwed();
  await settle();
  assert.deepEqual(calls.filter((x) => x[0] === "assign" || x[0] === "chat").map((x) => x.map(String).join(" ")), ["chat " + sid + " null null"]);
});

test("a queued new chat cancelled before it went out leaves its project", async () => {
  const { c, calls } = fixture();
  vm.runInContext("PROJECTS.newFor = {id: 'pris1234', log: S.log};", c);
  c.submit();
  const sid = c.S.sessionId;
  await settle();
  c.unqueueMessage(0);
  await settle();
  assert.deepEqual(calls.filter((x) => x[0] === "assign").map((x) => x.map(String).join(" ")), ["assign " + sid + " pris1234", "assign " + sid + " null"]);
  assert.equal(vm.runInContext("PROJECTS.state.chats[" + JSON.stringify(sid) + "]", c), undefined);
});
