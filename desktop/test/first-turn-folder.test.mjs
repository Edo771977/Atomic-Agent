// Review of issue #67 (third round), item 2: a project chat's first turn
// runs in the project's folder, but the send uses the project mark up
// (projectForNewTurn) and the window kept no other record of that folder.
// Until the agent stored the chat, the workspace chip, the provisional
// "restricted to: …" chip and the code block's Terminal button all used the
// window's folder: a restricted project in an open window lost its chip at
// the send and Terminal opened the wrong folder (the reverse showed a false
// restriction). The turn's record (LIVE_TURNS) now keeps the folder it runs
// in, the chat's pending row takes it once the stream names the session, and
// those read it first. The renderer's own steps in a vm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

// Main's own matcher answers the provisional chip (agent:folderConstraint), as on Windows.
const FC = createRequire(import.meta.url)("../out/main/folder-constraint.js");
const folderConstraint = (constraints) => async (dir) => ({ known: true,
  constraint: FC.folderConstraintFor(constraints, dir, { platform: "win32", realpath: () => undefined, worktreeSource: () => undefined }) });
const settle = () => new Promise((r) => setImmediate(r));

const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const renderer = src("../renderer/renderer.js");
function fn(name) {
  let at = renderer.indexOf("\nfunction " + name + "(");
  if (at < 0) at = renderer.indexOf("\nasync function " + name + "(");
  if (at < 0) throw new Error("no function " + name);
  return renderer.slice(at + 1, renderer.indexOf("\n}\n", at) + 2);
}

const EIS = "C:\\Users\\edoar\\eis";
const RIS = "C:\\Users\\edoar\\Downloads\\riservata";
const STORE = { id: "pris1234", name: "Riservata", folder: RIS, instructions: "", createdAt: 1 };

function window() {
  const c = vm.createContext({
    WORKSPACE: EIS, IS_WIN: true, IS_MAC: false, SEP_RE: /[\\/]+/, SET: {}, SK: {}, BR: {}, SESSIONS: [],
    S: { room: "chat", agentSession: null, sessionId: "", turnId: null, log: [], live: {} },
    LIVE_TURNS: new Map(), PENDING_CHATS: new Map(), FIRST_TURNS: new Map(), RUNNING: new Map(),
    LIVE_CONFIG: { projects: { constraints: { [RIS]: { allowedProviders: ["local-llama"] } } } },
    ProjectModels: { state: { chats: {}, loaded: true, remote: false } },
    esc: (s) => String(s), ic: () => "", homeDir: () => "C:\\Users\\edoar", attQueueLabel: (t) => String(t),
    providerWord: (x) => x, rmNow: () => ({ effective: "local" }), document: { querySelector: () => null, addEventListener: () => {} }, setTimeout,
    saveFolders: () => {},
  });
  c.BR = { folderConstraint: folderConstraint(c.LIVE_CONFIG.projects.constraints) };
  for (const f of ["chat-list.js", "chat-folders.js", "chat-projects.js", "chat-restriction.js"]) vm.runInContext(src("../renderer/" + f), c);
  vm.runInContext("PROJECTS.state = {projects: [" + JSON.stringify(STORE) + "], chats: {}};", c);
  for (const n of ["wsName", "workingDir", "chatTitle", "noteFirstPrompt", "firstTurnSent", "firstTurnNamed", "firstTurnEnded",
    "firstTurnFolder", "screenTurnFolder", "chatWorkingDir", "workspaceChipTarget", "workspaceChipInfo", "workspaceChipHTML", "mdTermCwd"]) {
    vm.runInContext(fn(n), c);
  }
  return c;
}

/* What startLiveTurn does for a new chat's first message in the project
   (its mark already used up), then the turn on screen. */
function sendInProject(c) {
  const folder = c.firstTurnFolder(undefined, STORE.id);
  const item = { id: "r1", k: "assistant", text: "" };
  c.S.log.push({ id: "a1", k: "user", text: "Plan" }, item);
  c.S.turnId = "t1"; c.S.streamId = "r1";
  c.LIVE_TURNS.set("t1", { text: "Plan", item, log: c.S.log, folder, ended: null });
  c.RUNNING.set("t1", null);
  c.firstTurnSent("t1", "Plan", STORE.id);
}

test("a restricted project's first turn keeps its folder on every surface while it runs", async () => {
  const c = window();
  sendInProject(c);
  assert.equal(c.chatWorkingDir(), RIS);
  assert.equal(c.mdTermCwd(), RIS, "Terminal opens where the turn runs");
  c.restrictionChipHTML(); await settle();
  assert.match(c.restrictionChipHTML(), /restricted to: local-llama/);
  const chip = c.workspaceChipHTML();
  assert.match(chip, /<span>riservata<\/span>/);
  assert.match(chip, /title="This new chat works in C:\\Users\\edoar\\Downloads\\riservata\. Choosing a folder changes where other new chats open\."/);
});

test("once the stream names the session, the chat's row keeps that folder until the agent stores it", () => {
  const c = window();
  sendInProject(c);
  c.firstTurnNamed("t1", "s-1");
  c.S.agentSession = "s-1"; c.S.sessionId = "s-1";
  assert.equal(c.PENDING_CHATS.get("s-1").workingDir, RIS);
  assert.equal(c.chatWorkingDir(), RIS);
  assert.equal(c.mdTermCwd(), RIS);
});

test("an open window's plain new chat runs in the window's folder, with no restriction", async () => {
  const c = window();
  assert.equal(c.firstTurnFolder(undefined, undefined), EIS);
  assert.equal(c.firstTurnFolder("s-old", undefined), "", "a chat with a session keeps its own");
  const item = { id: "r1" };
  c.S.log.push(item); c.S.turnId = "t2";
  c.LIVE_TURNS.set("t2", { item, log: c.S.log, folder: EIS, ended: null });
  assert.equal(c.chatWorkingDir(), EIS);
  c.restrictionChipHTML(); await settle();
  assert.equal(c.restrictionChipHTML(), "");
});

test("startLiveTurn keeps the folder in the turn's record", () => {
  assert.match(fn("startLiveTurn"), /live\.folder = firstTurnFolder\(waiting \? undefined : session, turnPid\);/);
});
