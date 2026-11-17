// W2 QA (16.11): one kind of group in the sidebar, Projects. A project has a
// folder on disk (the projects store) or none (a chat folder, chat-folders.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { projectItems } = require("../renderer/chat-list.js");
const F = require("../renderer/chat-folders.js");

test("projects with and without a disk folder are one list, the latest chat first", () => {
  const groups = [
    { project: { id: "paaaaaa", name: "app", folder: "/src/app", createdAt: 10 }, rows: [{ id: "s1", updatedAt: 100 }] },
    { project: { id: "pbbbbbb", name: "site", folder: "/src/site", createdAt: 20 }, rows: [] },
  ];
  const folders = [
    { folder: { id: "f1", name: "Marketing", collapsed: false }, rows: [{ id: "s2", updatedAt: 300 }] },
    { folder: { id: "f2", name: "New one", collapsed: false, createdAt: 200 }, rows: [] },
  ];
  const items = projectItems(groups, folders);
  assert.deepEqual(items.map((i) => i.id), ["f1", "f2", "paaaaaa", "pbbbbbb"]);
  assert.deepEqual(items.map((i) => i.kind), ["folder", "folder", "project", "project"]);
  assert.equal(items[0].name, "Marketing");
});

test("a folder keeps its instructions and when it was made; a new one is stamped", () => {
  const st = F.foldersCoerce({ folders: [{ id: "fa", name: "A", instructions: "  be brief ", createdAt: 5 }, { id: "fb", name: "B", instructions: 3 }] });
  assert.deepEqual(st.folders, [{ id: "fa", name: "A", collapsed: false, instructions: "be brief", createdAt: 5 }, { id: "fb", name: "B", collapsed: false }]);
  const id = F.folderAdd(st, "C");
  assert.ok(F.folderById(st, id).createdAt > 0);
});

/* The renderer half, in one context with the globals it reads at call time. */
function load() {
  const ctx = {
    console, setTimeout: () => 0, localStorage: undefined, document: undefined, window: undefined,
    esc: (s) => String(s), ic: (n) => "<" + n + ">", lucideIcon: (n) => "<" + n + ">", chatRow: (r) => "[row " + r.id + "]",
    toasts: [], saved: 0, assigned: [], rendered: 0, acts: [],
  };
  ctx.toast = (t) => ctx.toasts.push(t);
  ctx.render = () => { ctx.rendered++; };
  ctx.act = (a) => ctx.acts.push(a);
  ctx.savePrefs = () => {};
  ctx.sheet = (title, body, foot) => "<sheet " + title + ">" + body + foot;
  ctx.S = { sessionId: null, overlay: null, busy: false, log: [] };
  ctx.PREFS = { pinned: [] };
  ctx.BR = {
    projectsList: async () => ({ ok: true, data: { projects: [], chats: {} } }),
    projectsSave: async (p) => ({ ok: true, data: { id: "pnewone1", name: p.name, folder: p.folder, instructions: p.instructions, createdAt: 1 } }),
    projectsAssign: async (p) => { ctx.assigned.push(p); return { ok: true }; },
    overnightPickFolder: async () => "/src/picked",
  };
  vm.createContext(ctx);
  for (const f of ["chat-list.js", "chat-folders.js", "chat-projects.js"]) {
    vm.runInContext(readFileSync(new URL("../renderer/" + f, import.meta.url), "utf8"), ctx, { filename: f });
  }
  vm.runInContext("saveFolders = () => { saved++; };", ctx);
  return ctx;
}

test("the sidebar draws chat folders under Projects, with Edit, Remove and a drop target", () => {
  const c = load();
  vm.runInContext(`
    PROJECTS.state = projectsCoerce({projects: [{id: 'paaaaaa', name: 'app', folder: '/src/app'}]});
    FOLDERS.state = foldersCoerce({folders: [{id: 'f1', name: 'Marketing'}], chats: {s2: 'f1'}});
  `, c);
  const html = vm.runInContext(`projectsSidebarHTML([{project: PROJECTS.state.projects[0], rows: []}], [{folder: FOLDERS.state.folders[0], rows: [{id: 's2', updatedAt: 5}]}])`, c);
  assert.match(html, /<span>Projects<\/span>/);
  assert.ok(html.indexOf("Marketing") < html.indexOf(">app<"), "the project with the latest chat first");
  assert.match(html, /data-fdrop="f1"[^>]*><button type="button" class="sb-ftoggle" data-act="ftoggle:f1"/);
  assert.match(html, /data-fdrop="paaaaaa"[^>]*><button type="button" class="sb-ftoggle" data-act="ptoggle:paaaaaa"/);
  assert.match(html, /data-act="pedit:f1"/);
  assert.match(html, /data-act="pdelask:f1"/);
  assert.match(html, /\[row s2\]/);
  assert.doesNotMatch(html, /Folders/);
});

test("past five projects the rest fold behind Show N more projects", () => {
  const c = load();
  const html = vm.runInContext(`(() => {
    const fs = []; for (let i = 0; i < 8; i++) fs.push({folder: {id: 'f' + i, name: 'P' + i, collapsed: true, createdAt: 100 - i}, rows: []});
    return projectsSidebarHTML([], fs);
  })()`, c);
  assert.match(html, /data-act="pmore:">Show 3 more projects</);
  vm.runInContext(`projectAct('pmore', '')`, c);
  assert.match(vm.runInContext(`projectsSidebarHTML([], [0,1,2,3,4,5].map((i) => ({folder: {id: 'f' + i, name: 'P' + i, collapsed: true}, rows: []})))`, c), /Show fewer projects/);
});

test("New project with no disk folder is a chat folder with its instructions, and a new chat opens in it", async () => {
  const c = load();
  vm.runInContext(`projectAct('pnew', ''); PROJECTS.create.name = 'Marketing'; PROJECTS.create.instructions = 'Write in English';`, c);
  assert.equal(c.S.overlay, "pnew");
  assert.match(vm.runInContext("projectCreateHTML()", c), /Choose folder…/);
  await vm.runInContext("projectCreateSave()", c);
  const f = vm.runInContext("FOLDERS.state.folders[0]", c);
  assert.equal(f.name, "Marketing");
  assert.equal(f.instructions, "Write in English");
  assert.deepEqual(c.acts, ["session:new"]);
  assert.equal(c.S.overlay, null);
  // The first turn carries the folder's id (main reads its instructions), and the chat is filed once it has an id.
  const pid = vm.runInContext("projectForNewTurn()", c);
  assert.equal(pid, f.id);
  vm.runInContext(`projectNoteTurn('t1', '${pid}'); projectFileNewChat('t1', 'sNew')`, c);
  assert.equal(vm.runInContext("FOLDERS.state.chats.sNew", c), f.id);
});

test("New project with a folder goes to the projects store; an empty name is refused", async () => {
  const c = load();
  vm.runInContext(`projectAct('pnew', '')`, c);
  await vm.runInContext("projectCreateSave()", c);
  assert.equal(vm.runInContext("PROJECTS.create.error", c), "Give the project a name");
  await vm.runInContext("projectCreatePick()", c);
  assert.equal(vm.runInContext("PROJECTS.create.name", c), "picked", "named after the folder when no name was typed");
  await vm.runInContext("projectCreateSave()", c);
  assert.equal(vm.runInContext("PROJECTS.state.projects[0].folder", c), "/src/picked");
  assert.equal(vm.runInContext("FOLDERS.state.folders.length", c), 0);
  assert.equal(vm.runInContext("projectForNewTurn()", c), "pnewone1");
});

test("Move to project lists every project; moving into a store project takes the chat out of its folder", () => {
  const c = load();
  vm.runInContext(`
    PROJECTS.state = projectsCoerce({projects: [{id: 'paaaaaa', name: 'app', folder: '/src/app'}]});
    FOLDERS.state = foldersCoerce({folders: [{id: 'f1', name: 'Marketing'}], chats: {s2: 'f1'}});
  `, c);
  const items = JSON.parse(JSON.stringify(vm.runInContext("projectPickItems('s2')", c)));
  assert.deepEqual(items.map((i) => i.label), ["app", "Marketing", "No project", "New project…"]);
  assert.equal(items.find((i) => i.on).label, "Marketing");
  assert.equal(items[3].act, "pnew:s2");
  assert.ok(vm.runInContext("projectPutChat('s2', 'paaaaaa')", c));
  assert.equal(vm.runInContext("FOLDERS.state.chats.s2", c), null);
  assert.equal(vm.runInContext("PROJECTS.state.chats.s2", c), "paaaaaa");
  assert.deepEqual(JSON.parse(JSON.stringify(c.assigned)), [{ sessionId: "s2", projectId: "paaaaaa" }]);
});

test("a project with no disk folder edits and removes like any other", () => {
  const c = load();
  vm.runInContext(`FOLDERS.state = foldersCoerce({folders: [{id: 'f1', name: 'Marketing'}], chats: {s2: 'f1'}});`, c);
  vm.runInContext(`projectAct('pedit', 'f1'); PROJECTS.edit.name = 'Growth'; PROJECTS.edit.instructions = 'Be brief';`, c);
  assert.doesNotMatch(vm.runInContext("projectEditHTML()", c), /class="sd-cap mono"/, "no disk folder line");
  vm.runInContext("projectEditSave()", c);
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext("FOLDERS.state.folders[0]", c))), { id: "f1", name: "Growth", collapsed: false, instructions: "Be brief" });
  vm.runInContext(`projectAct('pdelask', 'f1')`, c);
  assert.equal(c.S.alert.msg, "Its chats stay, under Chats.");
  vm.runInContext(`projectAct('pdel', 'f1')`, c);
  assert.equal(vm.runInContext("FOLDERS.state.folders.length", c), 0);
  assert.equal(vm.runInContext("FOLDERS.state.chats.s2", c), null);
});

// Issue #62: a project's header starts a new chat in that project.
test("each project header has a New chat + that opens a new chat in that project without folding it", () => {
  const c = load();
  vm.runInContext(`
    PROJECTS.state = projectsCoerce({projects: [{id: 'paaaaaa', name: 'app', folder: '/src/app'}]});
    FOLDERS.state = foldersCoerce({folders: [{id: 'f1', name: 'Marketing'}]});
  `, c);
  const html = vm.runInContext(`projectsSidebarHTML([{project: PROJECTS.state.projects[0], rows: []}], [{folder: FOLDERS.state.folders[0], rows: []}])`, c);
  for (const [id, name] of [["paaaaaa", "app"], ["f1", "Marketing"]]) {
    assert.match(html, new RegExp('<button type="button" class="sesmore iconbtn" data-act="pchat:' + id + '" title="New chat in ' + name + '" aria-label="New chat in ' + name + '">'),
      "the header of " + id + " has a New chat control");
    // After the fold toggle and ahead of Edit; its own button, so a click on it never toggles the fold.
    const head = html.slice(html.indexOf('data-act="' + (id[0] === "f" ? "ftoggle:" : "ptoggle:") + id + '"'));
    assert.ok(head.indexOf("</button>") < head.indexOf('data-act="pchat:' + id + '"'));
    assert.ok(head.indexOf('data-act="pchat:' + id + '"') < head.indexOf('data-act="pedit:' + id + '"'));
  }
  assert.match(html, /No chats yet\. Start one with \+ or drag a chat here/);

  for (const id of ["paaaaaa", "f1"]) {
    c.acts.length = 0;
    const before = vm.runInContext(`[...PROJECTS.collapsed].join()`, c);
    vm.runInContext(`S.log = ['old chat']; S.agentSession = 'sOld'; act = (a) => { acts.push(a); if (a === 'session:new') { S.log = []; S.agentSession = null; } };`, c);
    assert.equal(vm.runInContext(`projectAct('pchat', '${id}')`, c), true);
    assert.deepEqual(c.acts, ["session:new"]);
    assert.equal(vm.runInContext("PROJECTS.newFor.id", c), id);
    assert.equal(vm.runInContext("PROJECTS.newFor.log === S.log", c), true, "marked on the new chat's transcript");
    assert.equal(vm.runInContext(`[...PROJECTS.collapsed].join()`, c), before, "the fold is untouched");
    assert.equal(vm.runInContext("FOLDERS.state.folders[0].collapsed", c), false);
    assert.equal(vm.runInContext("projectForNewTurn()", c), id, "the next first turn opens in that project");
    assert.equal(vm.runInContext("projectForNewTurn()", c), undefined, "read once");
  }
  // A project that is gone opens nothing.
  c.acts.length = 0;
  vm.runInContext(`projectAct('pchat', 'pgone00')`, c);
  assert.deepEqual(c.acts, []);
});

// Review of #62, item 1: a first turn main refuses keeps the project for the retry.
test("a refused first turn gives the project mark back, so the retry still opens in the project", () => {
  const c = load();
  vm.runInContext(`FOLDERS.state = foldersCoerce({folders: [{id: 'f1', name: 'Marketing'}]}); projectAct('pchat', 'f1');`, c);
  const log = vm.runInContext("S.log", c);
  assert.equal(vm.runInContext("projectForNewTurn()", c), "f1");
  vm.runInContext("S.log.push({k: 'user'}, {k: 'system', text: 'could not start the turn'})", c);
  vm.runInContext("projectNewTurnFailed('f1', S.log)", c);
  assert.equal(vm.runInContext("S.log", c), log);
  assert.equal(vm.runInContext("projectForNewTurn()", c), "f1", "the retry carries the project");
  // A turn with no project, or one whose chat was left meanwhile, gives nothing back.
  vm.runInContext("projectNewTurnFailed(undefined, S.log)", c);
  assert.equal(vm.runInContext("PROJECTS.newFor", c), null);
  vm.runInContext("projectNewTurnFailed('f1', ['another chat'])", c);
  assert.equal(vm.runInContext("projectForNewTurn()", c), undefined);
});

// Review of #62, item 2: a new chat's first turn in a store project takes that project's cloud model, not the window folder's.
test("a new chat in a store project looks its cloud model up by the project's folder", () => {
  const c = load();
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  const at = src.indexOf("\nfunction projectTurnModel(");
  assert.ok(at >= 0);
  vm.runInContext(src.slice(at + 1, src.indexOf("\n}\n", at) + 2), c);
  vm.runInContext(`
    ProjectModels = {folderOf: (sid, win) => (sid && sid === 'sOld' ? '/src/old' : win || ''), turnModel: (folder) => folder ? 'model of ' + folder : null};
    workingDir = () => '/window'; llmProviders = () => []; liveBackend = () => 'cloud';
    PROJECTS.state = projectsCoerce({projects: [{id: 'paaaaaa', name: 'app', folder: '/src/app'}]});
  `, c);
  assert.equal(vm.runInContext("projectTurnModel(undefined, 'paaaaaa')", c), "model of /src/app", "the turn's project");
  assert.equal(vm.runInContext("projectTurnModel('sOld', 'paaaaaa')", c), "model of /src/old", "a stored chat keeps its own");
  assert.equal(vm.runInContext("projectTurnModel(undefined, undefined)", c), "model of /window");
  // While the new chat is marked for the project (before its first turn), the chip reads the same model.
  vm.runInContext("projectAct('pchat', 'paaaaaa')", c);
  assert.equal(vm.runInContext("projectTurnModel(null)", c), "model of /src/app");
  assert.equal(vm.runInContext("PROJECTS.newFor && PROJECTS.newFor.id", c), "paaaaaa", "looking does not use the mark up");
});

/* Review of #62, items 3, 4 and 7: the header's controls are real buttons,
   siblings of the fold toggle. A tiny tree over the markup the sidebar
   draws (tags and quoted attributes only) with closest(), enough to run the
   drawer's real click listener from renderer.js against it. */
class El {
  constructor(tag, attrs, parent) { this.tag = tag; this.attrs = attrs; this.parent = parent; this.kids = []; }
  matches(sel) {
    return sel.split(",").some((one) => {
      const parts = one.trim().split(/\s+/);
      if (!this.matchOne(parts[parts.length - 1])) return false;
      let n = this.parent;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (n && !n.matchOne(parts[i])) n = n.parent;
        if (!n) return false;
        n = n.parent;
      }
      return true;
    });
  }
  matchOne(c) {
    const re = /^([a-z0-9]+)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:(\^?=)"([^"]*)")?\]/gy;
    let m, end = 0;
    while (end < c.length && (m = re.exec(c))) {
      end = re.lastIndex;
      if (m[1] && this.tag !== m[1]) return false;
      if (m[2] && this.attrs.id !== m[2]) return false;
      if (m[3] && !(this.attrs.class || "").split(" ").includes(m[3])) return false;
      if (m[4]) {
        const v = this.attrs[m[4]];
        if (v === undefined) return false;
        if (m[5] === "=" && v !== m[6]) return false;
        if (m[5] === "^=" && !v.startsWith(m[6])) return false;
      }
    }
    assert.equal(end, c.length, "the test tree reads selector " + c);
    return true;
  }
  closest(sel) { for (let n = this; n; n = n.parent) if (n.tag && n.matches(sel)) return n; return null; }
  all(pred, out = []) { for (const k of this.kids) { if (pred(k)) out.push(k); k.all(pred, out); } return out; }
}
function tree(html) {
  const root = new El("", {}, null);
  let at = root;
  const unq = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*>/g)) {
    if (m[1]) { assert.equal(at.tag, m[2], "well-formed markup"); at = at.parent; continue; }
    const attrs = {};
    for (const a of m[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? "" : unq(a[2]);
    const el = new El(m[2], attrs, at);
    at.kids.push(el);
    at = el;
  }
  assert.equal(at, root, "every tag closed");
  return root;
}

test("a project header is a fold button with real New chat, Edit and Remove buttons beside it", () => {
  const c = load();
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  vm.runInContext(src.match(/\nconst esc = .*\n/)[0], c);   // the real escaping
  vm.runInContext(`ic = () => ''; lucideIcon = () => '';
    PROJECTS.state = projectsCoerce({projects: [{id: 'paaaaaa', name: 'a "b" <c>', folder: '/src/app'}]});
    FOLDERS.state = foldersCoerce({folders: [{id: 'f1', name: 'Marketing'}]});`, c);
  const html = vm.runInContext(`'<div id="sidebar">' + projectsSidebarHTML([{project: PROJECTS.state.projects[0], rows: []}], [{folder: FOLDERS.state.folders[0], rows: []}]) + '</div>'`, c);
  const doc = tree(html);
  assert.doesNotMatch(html, /role="button"/, "no span posing as a button");
  for (const b of doc.all((n) => n.tag === "button")) assert.equal(b.all((n) => n.tag === "button").length, 0, "no button inside a button");
  const by = (act) => doc.all((n) => n.attrs["data-act"] === act)[0];
  for (const [id, fold, name] of [["paaaaaa", "ptoggle:", 'a "b" <c>'], ["f1", "ftoggle:", "Marketing"]]) {
    const head = doc.all((n) => n.attrs["data-fdrop"] === id)[0];
    assert.ok(head && head.matches(".sb-fhead"), "the header row takes the dragged chat");
    const toggle = by(fold + id), plus = by("pchat:" + id), edit = by("pedit:" + id), remove = by("pdelask:" + id);
    assert.equal(toggle.tag, "button");
    assert.equal(toggle.attrs["aria-expanded"], "true");
    assert.deepEqual([plus, edit, remove].map((b) => b && b.tag), ["button", "button", "button"]);
    assert.ok([toggle, plus, edit, remove].every((b) => b.parent === head), "siblings in the header, in this order");
    assert.deepEqual(head.kids.map((k) => k.attrs["data-act"]).filter(Boolean), [fold + id, "pchat:" + id, "pedit:" + id, "pdelask:" + id]);
    assert.equal(plus.attrs.title, "New chat in " + name);
    assert.equal(plus.attrs["aria-label"], "New chat in " + name);
    assert.equal(plus.attrs.type, "button");
  }
  assert.match(html, /title="New chat in a &quot;b&quot; &lt;c&gt;"/);

  // The narrow window's drawer: the real click listener. Enter or Space on a real button is this same click.
  const at = src.indexOf("  document.addEventListener('click', (e) => {\n    if (!sidebarDrawerOpen()");
  assert.ok(at >= 0);
  const listener = src.slice(at, src.indexOf("}, true);", at) + "}, true);".length);
  const d = vm.createContext({ Element: El, S: { overlay: null }, sidebarDrawerOpen: () => true, closed: 0, handlers: [] });
  d.setTimeout = (f) => f();
  d.closeSidebarDrawer = () => { d.closed++; };
  d.document = { addEventListener: (type, f) => d.handlers.push(f) };
  vm.runInContext(listener, d);
  const click = (el) => { d.closed = 0; d.handlers[0]({ target: el }); return d.closed; };
  assert.equal(click(by("pchat:paaaaaa")), 1, "New chat closes the drawer, as New chat does");
  assert.equal(click(by("pchat:f1")), 1);
  assert.equal(click(by("ptoggle:paaaaaa").kids[2]), 0, "folding keeps it");
  assert.equal(click(by("pedit:f1")), 0, "Edit keeps it (its sheet opens over it)");
  // And no keydown branch for spans is left to keep in step with it.
  assert.doesNotMatch(src, /\.sb-fhead \[role="button"\]/);
});

test("an import-sorted chat folder's new chat runs in its directory, as main picks it", () => {
  const c = load();
  vm.runInContext(`isAbsPath = (p) => String(p).startsWith('/');
    FOLDERS.state = foldersCoerce({folders: [{id: 'fa', name: 'app'}, {id: 'fb', name: 'repo'}, {id: 'fc', name: 'Plain'}], projects: {fa: '/src/app', fb: 'worktree-repo/repo'}});`, c);
  assert.equal(vm.runInContext("projectTurnFolder('fa')", c), "/src/app");
  assert.equal(vm.runInContext("projectTurnFolder('fb')", c), "", "a repository name only");
  assert.equal(vm.runInContext("projectTurnFolder('fc')", c), "");
});
