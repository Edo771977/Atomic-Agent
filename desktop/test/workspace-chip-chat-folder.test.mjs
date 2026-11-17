// Issue #67 (owner's Windows screenshot): with a project chat open, the
// workspace chip at the top of the sidebar still named the window's folder
// for new chats ("eis"), not the folder the open chat works in. While a chat
// with a session is on screen the chip now names THAT chat's folder (as the
// agent stored it, or its project's), "This chat works in <path>" plus its
// project; a new chat (one marked for a project included) keeps the folder
// it will open in. Choosing a folder from the chip still does what it did;
// the tooltip says which folder that changes. Settings › General and
// Diagnostics keep meaning the folder for new chats; the code block's
// Terminal and the chat's file list use the open chat's folder.
// The renderer's functions in a vm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const renderer = src("../renderer/renderer.js");
function fn(name) {
  let at = renderer.indexOf("\nfunction " + name + "(");
  if (at < 0) at = renderer.indexOf("\nasync function " + name + "(");
  if (at < 0) return "";
  return renderer.slice(at + 1, renderer.indexOf("\n}\n", at) + 2);
}

const EIS = "C:\\Users\\edoar\\eis";
const RIS = "C:\\Users\\edoar\\Downloads\\riservata";

function window(over = {}) {
  const c = vm.createContext({
    WORKSPACE: EIS, IS_WIN: true, SEP_RE: /[\\/]+/, S: { room: "chat", agentSession: null, sessionId: null, live: {} },
    SET: {}, SK: {}, BR: {}, SESSIONS: [], esc: (s) => String(s), ic: () => "", homeDir: () => "C:\\Users\\edoar",
    ProjectModels: { state: { chats: {} } }, ...over,
  });
  for (const f of ["chat-list.js", "chat-folders.js", "chat-projects.js"]) vm.runInContext(src("../renderer/" + f), c);
  vm.runInContext("PROJECTS.state = {projects: [{id: 'pris1234', name: 'Riservata', folder: " + JSON.stringify(RIS)
    + ", instructions: '', createdAt: 1}], chats: {'s-1': 'pris1234'}};", c);
  for (const n of ["wsName", "workingDir", "workingDirLabel", "chatWorkingDir", "workspaceChipInfo", "workspaceChipHTML"]) {
    const s = fn(n); if (s) vm.runInContext(s, c);
  }
  return c;
}

test("an open project chat's chip names that chat's folder and its project", () => {
  const c = window();
  c.S.agentSession = "s-1"; c.S.sessionId = "s-1";
  c.ProjectModels.state.chats["s-1"] = RIS;
  assert.equal(typeof c.workspaceChipHTML, "function");
  const html = c.workspaceChipHTML();
  assert.match(html, /<span>riservata<\/span>/);
  assert.match(html, /title="This chat works in C:\\Users\\edoar\\Downloads\\riservata \(project Riservata\)\. Choosing a folder moves this chat there; a restricted chat keeps its restriction\."/);
  assert.equal(c.chatWorkingDir(), RIS);
});

test("the folder comes from the stored list row, else the chat's project, when the chat was not opened here", () => {
  const c = window({ SESSIONS: [{ id: "s-2", workingDir: "D:\\work\\api" }] });
  c.S.agentSession = "s-2"; c.S.sessionId = "s-2";
  assert.equal(c.workspaceChipInfo().dir, "D:\\work\\api");
  c.S.agentSession = "s-1"; c.S.sessionId = "s-1";
  assert.equal(c.workspaceChipInfo().dir, RIS);
});

test("with no chat on screen, or a new chat, the chip keeps the folder for new chats", () => {
  const c = window();
  const info = c.workspaceChipInfo();
  assert.equal(info.dir, EIS);
  assert.equal(info.kind, "new");
  assert.match(c.workspaceChipHTML(), /<span>eis<\/span>/);
  assert.match(c.workspaceChipHTML(), /title="New chats open in C:\\Users\\edoar\\eis\. Choose another folder\."/);
  c.S.room = "studio"; c.S.agentSession = "s-1";
  assert.equal(c.workspaceChipInfo().kind, "new", "a Studio page is no chat");
});

test("a new chat marked for a project names the project folder it will open in", () => {
  const c = window();
  c.S.log = [];
  vm.runInContext("PROJECTS.newFor = {id: 'pris1234', log: S.log};", c);
  const info = c.workspaceChipInfo();
  assert.equal(info.dir, RIS);
  assert.match(c.workspaceChipHTML(), /title="This new chat in Riservata opens in C:\\Users\\edoar\\Downloads\\riservata\. Choosing a folder changes where other new chats open\."/);
});

test("the sidebar draws that chip; Terminal and the file list follow the open chat; Settings and Diagnostics keep the new-chat folder", () => {
  assert.match(renderer, /\+ '<div class="sb-head">' \+ MARK_COLOR\n\s*\+ workspaceChipHTML\(\)/);
  assert.match(renderer, /terminalOpenWithCommand\(\{ command: text, cwd: chatWorkingDir\(\) \|\| workingDir\(\) \|\| null \}\)/);
  assert.match(src("../renderer/chat-files.js"), /typeof chatWorkingDir === 'function' \? chatWorkingDir\(\)/);
  assert.match(fn("generalPane"), /const ws = BR \? workingDir\(\) : ''/);
  assert.match(fn("generalPane"), /New chats open in this folder\./);
  assert.match(fn("diagnosticsPane"), /const wd = workingDir\(\);/);
});
