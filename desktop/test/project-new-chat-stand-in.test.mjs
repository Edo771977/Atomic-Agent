// Issue #67 (2): a chat opened with New project (or a project header's +)
// was missing from its project's list while its first turn ran, and showed
// up only once the turn ended and was stored. It is now under the project
// as soon as its first message is sent: a stand-in row keyed by the turn
// (`turn:<turnId>`, chat-projects.js projectStandIn*) carries the project,
// until the stream names the chat's session; from then on the chat's own
// row (item 27's stand-in, then the stored row) is filed there, once.
// The sidebar's renderer half and chat-projects.js in a vm.
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

const STORE = { id: "pabc1234", name: "Work", folder: "/home/me/work", instructions: "", createdAt: 1 };

function sidebar() {
  const c = vm.createContext({
    SESSIONS: [], PENDING_CHATS: new Map(), PREFS: { pinned: [] }, PAGE: { chats: 1 }, SIDEBAR_PAGE: 50,
    CHATSEARCH: { archOpen: false }, chatArchivedIds: () => new Set(), homeDir: () => "/home/me",
    attQueueLabel: (t) => String(t), console,
  });
  for (const f of ["chat-list.js", "chat-folders.js", "chat-projects.js"]) vm.runInContext(src("../renderer/" + f), c);
  for (const n of ["chatTitle", "sidebarChats"]) vm.runInContext(fn(n), c);
  vm.runInContext("PROJECTS.state = {projects: [" + JSON.stringify(STORE) + "], chats: {}};"
    + "FOLDERS.state = foldersEmpty(); var FID = folderAdd(FOLDERS.state, 'Notes');", c);
  const view = () => {
    const out = c.sidebarChats();
    const ids = (rows) => JSON.parse(JSON.stringify(rows.map((r) => r.id)));
    return { project: ids(out.projects[0].rows), folder: ids(out.groups[0].rows), loose: ids(out.rows) };
  };
  return { c, view, run: (code) => vm.runInContext(code, c) };
}

test("a new chat in a project is under it from its first message, before the stream names its session", () => {
  const { c, view, run } = sidebar();
  assert.equal(typeof c.projectStandInNote, "function", "chat-projects.js has the stand-in");
  c.projectStandInNote("t1", STORE.id, "Plan the release");
  assert.deepEqual(view(), { project: ["turn:t1"], folder: [], loose: [] });
  assert.equal(c.sidebarChats().projects[0].rows[0].t, "Plan the release");
  // The stream names the session: item 27's stand-in takes over, filed in the same project.
  c.PENDING_CHATS.set("s-1", { id: "s-1", t: "Plan the release", pending: true, turnCount: 0, updatedAt: 2 });
  c.projectStandInSession("t1", "s-1");
  assert.deepEqual(view(), { project: ["s-1"], folder: [], loose: [] });
  // Review of #67, item 6: the project rides on the chat's row, not in the store's map, until main's own read says so.
  assert.equal(run("PROJECTS.state.chats['s-1']"), undefined);
  assert.equal(c.PENDING_CHATS.get("s-1").projectId, STORE.id);
  // main's projects:changed: the store read files it (assignChat succeeded).
  run("PROJECTS.state = projectsCoerce({projects: [" + JSON.stringify(STORE) + "], chats: {'s-1': " + JSON.stringify(STORE.id) + "}});");
  // The stored row lands: still one row.
  c.SESSIONS.push({ id: "s-1", t: "Plan the release", turnCount: 1, updatedAt: 3 });
  assert.deepEqual(view(), { project: ["s-1"], folder: [], loose: [] });
  c.PENDING_CHATS.delete("s-1");
  assert.deepEqual(view(), { project: ["s-1"], folder: [], loose: [] });
});

test("review of #67: when main never files the chat (assignChat refused), the stored row is not kept in the project", () => {
  const { c, view } = sidebar();
  c.projectStandInNote("t9", STORE.id, "Too many chats");
  c.PENDING_CHATS.set("s-9", { id: "s-9", t: "Too many chats", pending: true, turnCount: 0, updatedAt: 2 });
  c.projectStandInSession("t9", "s-9");
  assert.deepEqual(view(), { project: ["s-9"], folder: [], loose: [] });
  c.SESSIONS.push({ id: "s-9", t: "Too many chats", turnCount: 1, updatedAt: 3 });
  c.PENDING_CHATS.delete("s-9");
  assert.deepEqual(view(), { project: [], folder: [], loose: ["s-9"] });
});

test("a project with no disk folder (a chat folder) gets the stand-in too", () => {
  const { c, view, run } = sidebar();
  const fid = run("FID");
  c.projectStandInNote("t2", fid, "Notes for Monday");
  assert.deepEqual(view(), { project: [], folder: ["turn:t2"], loose: [] });
  // projectFileNewChat files the chat by its session once named; the stand-in goes.
  run(`folderPut(FOLDERS.state, 's-2', FID)`);
  c.PENDING_CHATS.set("s-2", { id: "s-2", t: "Notes for Monday", pending: true, turnCount: 0, updatedAt: 2 });
  c.projectStandInSession("t2", "s-2");
  assert.deepEqual(view(), { project: [], folder: ["s-2"], loose: [] });
});

test("a turn that ends before naming a session takes its stand-in with it; a plain new chat gets none", () => {
  const { c, view } = sidebar();
  c.projectStandInNote("t3", STORE.id, "x");
  c.projectStandInEnded("t3");
  assert.deepEqual(view(), { project: [], folder: [], loose: [] });
  c.projectStandInNote("t4", undefined, "no project");
  c.projectStandInNote("t5", "pnope999", "unknown project");
  assert.deepEqual(view(), { project: [], folder: [], loose: [] });
  assert.equal(c.projectStandIn("turn:t4"), null);
});

test("the window notes the stand-in at the send, hands it over on session_id and drops it at the turn's end", () => {
  const send = renderer.slice(renderer.indexOf("function startLiveTurn("), renderer.indexOf("function noteFirstPrompt("));
  assert.match(send, /if \(opensChat\) \{ FIRST_TURNS\.set\(res\.turnId, text\); projectStandInNote\(res\.turnId, forProject, text\); \}/);
  const frames = renderer.slice(renderer.indexOf("if (ev.kind === 'session_id') {\n      const sid = pick("));
  assert.match(frames.slice(0, 900), /projectStandInSession\(ev\.turnId, sid\)/);
  assert.match(frames.slice(0, 2400), /projectStandInEnded\(ev\.turnId\)/);
  // A click on it shows the new chat on screen, and it is not dragged or given a chat menu.
  assert.match(fn("openSession"), /projectStandIn\(id\)/);
  assert.match(fn("chatRow"), /s\.standIn \? '' : ' draggable="true"'/);
});
