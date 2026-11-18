/* ---------------- ATO-1146: the sidebar by projects ----------------
   Loaded before renderer.js; declares only, and reads renderer.js globals at
   call time, as chat-folders.js does. The grouping itself is pure and lives
   in chat-list.js (projectGroups, unit-tested in test/chat-list.test.mjs).

   Epic ATO-1012, item 3. A project is a work folder plus a name, kept by the
   projects store (ATO-42, main/projects-store.ts, IPC projects:list / save /
   delete / assign and the projects:changed event). This file only draws it:

   - "New project" (a sidebar row, and the plus on the Projects heading) opens
     the system folder picker the workspace chip uses (app:chooseWorkspace,
     for new chats only: the chat on screen keeps its folder), saves a project
     named after that folder, and opens a new chat there. That chat's first
     turn carries the project's id (BR.chat's third argument): main records
     the chat in the project before the turn starts.
   - The sidebar shows each project with its chats, folding like a chat
     folder. A chat filed in an ATO-1034 chat folder stays in that folder.
   - New chat (the plus on a project's header, issue #62) opens a new chat in
     that project the way New project does once it has made one
     (projectNewChat): the first turn carries the project's id. Either way the
     chat is under the project from its first message (issue #67, a stand-in
     row keyed by the turn: projectStandInNote).
   - Edit (the pencil on a project's header): its name and its instructions,
     which main hands the agent with every turn of the project's chats.
   - Removing a project leaves its chats (under Chats) and the folder on disk.

   Without the store (an older main, or ATO-42 not in this build) nothing here
   is drawn: no row, no heading.

   W2 QA (16.11), the owner: "Folders and Projects, what is the difference?"
   One kind of group now, Projects, as in Claude. A project may have a folder
   on disk (the projects store, above) or none: a chat folder (ATO-1034,
   chat-folders.js), which import and the sorting make too and which is drawn
   here the same way, with the same Edit and Remove, its own instructions
   (main reads them for each turn, chat-folders.ts folderForTurn) and chats
   dragged in. The Folders section is gone. New project opens a sheet: a
   name, a folder on disk if you want one, instructions. */

const PROJECTS = {state: {projects: [], chats: {}}, loaded: false, collapsed: new Set(), newFor: null, edit: null, create: null,
  fileTurns: new Map(), showAll: false, standIns: new Map(), waiting: new Map()};
const PROJECT_INSTRUCTIONS_MAX = 16000;
const PROJECT_NAME_MAX = 80;
const PROJECTS_COLLAPSED_KEY = 'atomic.projects.collapsed';
/* Projects this window has already drawn. One that shows up from elsewhere
   (an import brings dozens at once) starts folded, the way Claude lists its
   projects; one made here with New project opens (projectCreate). */
const PROJECTS_KNOWN_KEY = 'atomic.projects.known';
const PROJECTS_KNOWN = new Set();
let PROJECTS_KNOWN_READ = false;

try {
  const raw = typeof localStorage !== 'undefined' ? JSON.parse(localStorage.getItem(PROJECTS_COLLAPSED_KEY) || '[]') : [];
  if (Array.isArray(raw)) for (const id of raw) if (typeof id === 'string') PROJECTS.collapsed.add(id);
  const known = typeof localStorage !== 'undefined' ? localStorage.getItem(PROJECTS_KNOWN_KEY) : null;
  if (known !== null) {
    PROJECTS_KNOWN_READ = true;
    const ids = JSON.parse(known);
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') PROJECTS_KNOWN.add(id);
  }
} catch (e) { /* a per-window convenience only */ }

function projectsSaveFolds() {
  try {
    localStorage.setItem(PROJECTS_COLLAPSED_KEY, JSON.stringify([...PROJECTS.collapsed]));
    localStorage.setItem(PROJECTS_KNOWN_KEY, JSON.stringify([...PROJECTS_KNOWN]));
  } catch (e) { /* kept for this run */ }
}

/* Fold every project not seen before. The very first read of a window that
   never stored the list (an update from a build without it) only records
   what is there, so projects someone already had open stay open. */
function projectsFoldNew(projects) {
  let changed = false;
  for (const p of projects) {
    if (PROJECTS_KNOWN.has(p.id)) continue;
    PROJECTS_KNOWN.add(p.id);
    if (PROJECTS_KNOWN_READ) PROJECTS.collapsed.add(p.id);
    changed = true;
  }
  PROJECTS_KNOWN_READ = true;
  if (changed) projectsSaveFolds();
}

/** The store's calls, or null when this build has none. */
function projectsApi() {
  if (typeof BR === 'undefined' || !BR) return null;
  if (typeof BR.projectsList !== 'function' || typeof BR.projectsSave !== 'function') return null;
  return BR;
}

function projectsSupported() { return !!projectsApi(); }

async function loadProjects() {
  const api = projectsApi();
  if (!api) { PROJECTS.loaded = true; return; }
  let res = null;
  try { res = await api.projectsList(); } catch (e) { res = null; }
  if (res && typeof res === 'object' && res.ok !== false) {
    PROJECTS.state = projectsCoerce('data' in res ? res.data : res);
    projectsFoldNew(PROJECTS.state.projects);
  }
  PROJECTS.loaded = true;
  if (typeof render === 'function') render();
}

/* The store says when it changed (any window, any write): read it again. */
if (typeof window !== 'undefined') {
  setTimeout(() => {
    const api = projectsApi();
    if (api && typeof api.onProjectsChanged === 'function') api.onProjectsChanged(() => { loadProjects(); });
  }, 0);
}

function projectCollapsed(id) { return PROJECTS.collapsed.has(id); }

function projectToggle(id) {
  if (PROJECTS.collapsed.has(id)) PROJECTS.collapsed.delete(id); else PROJECTS.collapsed.add(id);
  projectsSaveFolds();
}

/* The saved project out of a projects:save answer, or null. */
function projectFromSave(res) {
  if (!res || typeof res !== 'object' || res.ok === false) return null;
  const d = 'data' in res ? res.data : res;
  const p = d && d.project ? d.project : d;
  return projectsCoerce([p]).projects[0] || null;
}

/* The project a brand-new chat's first turn opens in (BR.chat's third
   argument), or undefined. Only the empty chat New project opened: a plain New
   chat or opening another chat since gives that chat a new transcript
   (S.log), so the mark is dropped. Read once. */
function projectForNewTurn() {
  const id = projectMarked();
  PROJECTS.newFor = null;
  return id;
}

/* The project the chat on screen is marked for, without using the mark up
   (the model chip, the empty chat's line), or undefined. */
function projectMarked() {
  const n = PROJECTS.newFor;
  if (!n || typeof S === 'undefined' || S.agentSession || S.log !== n.log) return undefined;
  if (PROJECTS.state.projects.some((p) => p.id === n.id)) return n.id;
  return typeof FOLDERS !== 'undefined' && folderById(FOLDERS.state, n.id) ? n.id : undefined;
}

/* What the empty chat says while it is marked for a project: the project's
   name and the folder its first turn runs in ('' for the window's), or null. */
function projectMarkedInfo() {
  const id = projectMarked();
  const p = id ? projectAny(id) : null;
  return p ? {id, name: p.name, folder: projectTurnFolder(id)} : null;
}

/* Clear Transcript in a new chat that has no session yet is still that new
   chat: the mark follows it onto the cleared transcript. */
function projectKeepMark(before, after) {
  const n = PROJECTS.newFor;
  if (n && n.log === before && typeof S !== 'undefined' && !S.agentSession) n.log = after;
}

/* The folder a new chat's first turn in project `pid` runs in, as main
   picks it (main.ts startTurn), or '' for the window's: a store project's
   folder on disk, or the directory the import sorted a chat folder by
   (main/chat-folders.ts folderTurnDir; main also checks it is there). */
function projectTurnFolder(pid) {
  if (typeof pid !== 'string' || !pid) return '';
  if (pid[0] === 'f') {
    const dir = typeof FOLDERS !== 'undefined' && FOLDERS.state.projects ? FOLDERS.state.projects[pid] : '';
    return typeof dir === 'string' && dir && typeof isAbsPath === 'function' && isAbsPath(dir) ? dir : '';
  }
  const p = PROJECTS.state.projects.find((x) => x.id === pid);
  return p && p.folder ? p.folder : '';
}

/* A first turn main refused ("could not start the turn"): the chat is still
   new, so the mark goes back and the next send opens in the project again.
   Not when the turn had none, the person has left that chat, or a newer mark
   was set meanwhile. */
function projectNewTurnFailed(pid, log) {
  if (!pid || PROJECTS.newFor || typeof S === 'undefined' || S.agentSession || S.log !== log) return;
  PROJECTS.newFor = {id: pid, log};
}

/* Issue #74: a new chat whose first message is queued while the model
   switches gets a `waiting-…` id at once (renderer.js submit), and its first
   turn goes out with that id, which main reads as a known chat: it finds the
   chat's project by the id (turnProject), never by the turn's project id. So
   the chat is filed in the project when the message is queued, and its first
   turn waits for that write (startLiveTurn). PROJECTS.waiting: sid →
   {pid, filed}, until that turn went out. */
function projectFileWaitingChat(sid, pid) {
  if (!sid || typeof pid !== 'string' || !pid) return;
  let filed = Promise.resolve();
  if (pid[0] === 'p') {
    const api = projectsApi();
    if (!api || typeof api.projectsAssign !== 'function' || !PROJECTS.state.projects.some((p) => p.id === pid)) return;
    PROJECTS.state.chats[sid] = pid;
    filed = Promise.resolve(api.projectsAssign({sessionId: sid, projectId: pid})).then((res) => {
      if (res && res.ok === false && typeof toast === 'function') toast('Could not file the chat in its project', res.error || '', 'bad');
    }, () => {});
  } else {
    if (typeof FOLDERS === 'undefined' || !folderPut(FOLDERS.state, sid, pid)) return;
    filed = Promise.resolve(saveFolders()).then(() => {}, () => {});
  }
  PROJECTS.waiting.set(sid, {pid, filed});
}
/** The waiting chat `sid`'s project and its filing, until its first turn went out (projectWaitingSent); or null. */
function projectWaitingTurn(sid) { return PROJECTS.waiting.get(sid) || null; }
function projectWaitingSent(sid) { PROJECTS.waiting.delete(sid); }
/* The waiting chat is gone before its message went out (cancelled, the chat
   deleted, its stand-in dropped from the list): so is its filing. Not while
   its first turn is on its way (`sending`, startLiveTurn). */
function projectWaitingCancelled(sid) {
  const e = PROJECTS.waiting.get(sid);
  if (!e || e.sending) return;
  PROJECTS.waiting.delete(sid);
  projectPutChat(sid, '');
}

/* Open a new chat in project `id` (a store id `p…` or a chat folder `f…`):
   New chat, then the mark projectForNewTurn reads. As New chat, a turn
   running in the chat on screen keeps running there (session:new). */
function projectNewChat(id) {
  act('session:new');
  PROJECTS.newFor = {id, log: S.log};
  render();
}

/* A new chat New project opened in a project with no disk folder: main reads
   that project's instructions for the first turn by its id, and the chat is
   filed in it here once the turn says its session id (renderer.js). */
function projectNoteTurn(turnId, pid) {
  if (turnId && typeof pid === 'string' && pid[0] === 'f') PROJECTS.fileTurns.set(turnId, pid);
}

function projectFileNewChat(turnId, sid) {
  const fid = PROJECTS.fileTurns.get(turnId);
  if (!fid) return;
  PROJECTS.fileTurns.delete(turnId);
  if (sid && typeof FOLDERS !== 'undefined' && folderPut(FOLDERS.state, sid, fid)) saveFolders();
}

/* Issue #67: a new chat in a project is under the project from its first
   message. Item 27's stand-in (renderer.js noteFirstPrompt) waits for the
   stream to name the chat's session, and the chat is filed by that id (main's
   projects:changed for a store project, projectFileNewChat for a chat folder),
   so until then the chat was nowhere, and the person saw it only once its
   turn was stored. PROJECTS.standIns: `turn:<turnId>` → {turnId, pid, row}, a
   row that carries its project (`projectId` for a store project, `folderId`
   for a chat folder: chat-list.js projectOf, chat-folders.js folderGroups),
   until projectStandInSession hands over to the chat's own row, or the turn
   ends without one. A turn not opened in a project gets none. */
function projectStandInNote(turnId, pid, text) {
  if (!turnId || typeof pid !== 'string' || !pid) return;
  const store = pid[0] === 'p' && PROJECTS.state.projects.some((p) => p.id === pid);
  const folder = pid[0] === 'f' && typeof FOLDERS !== 'undefined' && !!folderById(FOLDERS.state, pid);
  if (!store && !folder) return;
  const id = 'turn:' + turnId;
  const title = (typeof chatTitle === 'function' ? chatTitle(text) : String(text || '').trim()) || '(empty)';
  PROJECTS.standIns.set(id, {turnId, pid, row: {id, t: title, named: true, titled: false, updatedAt: Date.now(), status: '',
    turnCount: 0, pending: true, standIn: true, endedAt: null, ...(store ? {projectId: pid} : {folderId: pid})}});
}

/** The stand-in row `id` stands for, or null. */
function projectStandIn(id) {
  const e = typeof id === 'string' ? PROJECTS.standIns.get(id) : null;
  return e || null;
}

/** The stand-in rows, newest first (renderer.js sidebarChats). */
function projectStandInRows() {
  return [...PROJECTS.standIns.values()].map((e) => e.row).reverse();
}

/* The stream named turn `turnId`'s session: its stand-in goes, and the chat
   is in the project by its id from here. A store project's assignment is
   main's (startTurn's assignChat, then projects:changed). Until that read
   lands, item 27's row for the chat carries the project (`projectId`), so it
   does not leave the project meanwhile; the store's map is not written here
   (review of #67): an assignment main refused leaves the stored row out. */
function projectStandInSession(turnId, sid) {
  const e = PROJECTS.standIns.get('turn:' + turnId);
  if (!e) return;
  PROJECTS.standIns.delete('turn:' + turnId);
  const row = sid && e.pid[0] === 'p' && typeof PENDING_CHATS !== 'undefined' ? PENDING_CHATS.get(sid) : null;
  if (row) row.projectId = e.pid;
}

/** Turn `turnId` ended: a stand-in still waiting for its session goes. */
function projectStandInEnded(turnId) {
  PROJECTS.standIns.delete('turn:' + turnId);
}

/* New project (W2 QA): a sheet with a name, a folder on disk if wanted, and
   instructions. With a folder it is the projects store's, and a new chat
   opens there; without, it is a chat folder. Opened from a chat's "Move to
   project" list (`put`), the chat goes into it and no new chat opens. */
function projectCreateOpen(put) {
  if (!projectsApi()) return;
  PROJECTS.create = {name: '', folder: '', instructions: '', shownName: '', shownInstructions: '', error: null, saving: false, put: put || null};
  S.overlay = 'pnew';
  render();
  const f = typeof document !== 'undefined' && document.getElementById('pnew-name');
  if (f) f.focus();
}

function projectCreateRedraw(patch) {
  const c = PROJECTS.create;
  if (!c) return;
  Object.assign(c, patch, {shownName: c.name, shownInstructions: c.instructions});
  S.overlay = 'pnew';
  render();
}

async function projectCreatePick() {
  const c = PROJECTS.create;
  if (!c || c.saving || typeof BR === 'undefined' || !BR || typeof BR.overnightPickFolder !== 'function') return;
  let dir = null;
  try { dir = await BR.overnightPickFolder(c.folder || (typeof WORKSPACE === 'string' ? WORKSPACE : ''), 'project'); } catch (e) { dir = null; }
  if (PROJECTS.create !== c || typeof dir !== 'string' || !dir) return;
  projectCreateRedraw({folder: dir, name: c.name.trim() ? c.name : projectNameFromDir(dir), error: null});
}

/* Put chat `sid` in project `pid` (a store id `p…` or a folder id `f…`), or in none (''). */
function projectPutChat(sid, pid) {
  if (!sid) return false;
  if (pid && pid[0] === 'p') {
    const api = projectsApi();
    if (!api || typeof api.projectsAssign !== 'function' || !PROJECTS.state.projects.some((p) => p.id === pid)) return false;
    PROJECTS.state.chats[sid] = pid;
    api.projectsAssign({sessionId: sid, projectId: pid}).then((res) => {
      if (res && res.ok === false) toast('Could not move the chat', res.error || '', 'bad');
    }, () => {});
    // A chat folder wins over a project by path in the sidebar: it leaves the folder.
    if (folderPut(FOLDERS.state, sid, null)) saveFolders();
    return true;
  }
  if (!folderPut(FOLDERS.state, sid, pid || null)) return false;
  saveFolders();
  if (!pid && PROJECTS.state.chats[sid]) {
    delete PROJECTS.state.chats[sid];
    const api = projectsApi();
    if (api && typeof api.projectsAssign === 'function') api.projectsAssign({sessionId: sid, projectId: null}).then(() => {}, () => {});
  }
  return true;
}

async function projectCreateSave() {
  const c = PROJECTS.create, api = projectsApi();
  if (!c || !api || c.saving) return;
  const name = String(c.name || '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (!name) { projectCreateRedraw({error: 'Give the project a name'}); return; }
  if ([...name].length > PROJECT_NAME_MAX) { projectCreateRedraw({error: 'A project name is at most ' + PROJECT_NAME_MAX + ' characters'}); return; }
  if (c.instructions.length > PROJECT_INSTRUCTIONS_MAX) { projectCreateRedraw({error: 'Instructions are at most ' + PROJECT_INSTRUCTIONS_MAX + ' characters'}); return; }
  // As the workspace chip: no new chat opens over a chat that runs a turn.
  if (!c.put && S.busy) { if (typeof restartRefusedToast === 'function') restartRefusedToast({here: true, title: ''}); return; }
  let id;
  if (c.folder) {
    let p = projectForFolder(PROJECTS.state, c.folder);
    if (!p) {
      projectCreateRedraw({saving: true, error: null});
      let saved = null;
      try { saved = await api.projectsSave({name, folder: c.folder, instructions: c.instructions}); } catch (e) { saved = {ok: false, error: String(e && e.message || e)}; }
      if (PROJECTS.create !== c) return;   // closed meanwhile
      p = projectFromSave(saved);
      if (!p) { projectCreateRedraw({saving: false, error: (saved && saved.error) || 'The project was not created'}); return; }
      PROJECTS.state.projects.unshift(p);   // the store lists newest first
    }
    id = p.id;
    PROJECTS.collapsed.delete(id);
    PROJECTS_KNOWN.add(id);
    projectsSaveFolds();
  } else {
    id = folderAdd(FOLDERS.state, name);
    const f = folderById(FOLDERS.state, id);
    if (f && c.instructions.trim()) f.instructions = c.instructions.trim();
    saveFolders();
  }
  PROJECTS.create = null;
  if (S.overlay === 'pnew') S.overlay = null;
  if (c.put) {
    projectPutChat(c.put, id);
    if (PREFS.pinned.includes(c.put)) { PREFS.pinned = PREFS.pinned.filter((x) => x !== c.put); savePrefs(); }
    toast('Project created', 'The chat is in “' + name + '” now');
    render();
    return;
  }
  projectNewChat(id);
}

/** The New project sheet (S.overlay === 'pnew'). */
function projectCreateHTML() {
  const c = PROJECTS.create;
  if (!c) return '';
  const off = c.saving ? ' disabled' : '';
  const body = '<label class="sd-cap" for="pnew-name">Name</label>'
    + '<input id="pnew-name" class="tk-inp" maxlength="' + PROJECT_NAME_MAX + '" placeholder="For example: Marketing" value="' + esc(c.shownName) + '"' + off + '>'
    + '<label class="sd-cap">Folder on your computer <span class="sd-opt">optional</span></label>'
    + '<div class="sd-pnew-folder">'
      + (c.folder
        ? '<span class="mono grow" title="' + esc(c.folder) + '">' + esc(c.folder) + '</span>'
          + '<button class="btn btn-s sm" data-act="pnewpick:"' + off + '>Change</button>'
          + '<button class="btn btn-s sm" data-act="pnewclear:"' + off + '>Remove</button>'
        : '<span class="grow sd-cap">None. Chats in this project work in the folder the window shows.</span>'
          + '<button class="btn btn-s sm" data-act="pnewpick:"' + off + '>Choose folder…</button>')
    + '</div>'
    + '<label class="sd-cap" for="pnew-instr">Instructions for every chat in this project <span class="sd-opt">optional</span></label>'
    + '<textarea id="pnew-instr" class="tk-inp sd-json" rows="6" maxlength="' + PROJECT_INSTRUCTIONS_MAX + '"'
      + ' placeholder="For example: answer in English, run the tests before you say it works."' + off + '>' + esc(c.shownInstructions) + '</textarea>'
    + (c.error ? '<div class="tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(c.error) + '</span></div>' : '');
  return sheet('New project', body,
    '<span class="grow"></span><button class="btn btn-s sm" data-act="close">Cancel</button>'
    + '<button class="btn btn-p sm" data-act="pnewsave:"' + off + '>' + (c.saving ? '<span class="tk-spin"></span>' : '') + 'Create project</button>',
    'sheet-project');
}

/** Remove a project from the sidebar. Its chats stay, under Chats. */
function projectRemove(id) {
  if (id && id[0] === 'f') {
    if (folderRemove(FOLDERS.state, id)) { saveFolders(); toast('Project removed', 'Its chats are kept, under Chats'); }
    render();
    return;
  }
  const api = projectsApi();
  if (!api || typeof api.projectsDelete !== 'function') return;
  api.projectsDelete(id).then((res) => {
    if (res && res.ok === false) { toast('Could not remove the project', res.error || '', 'bad'); return; }
    PROJECTS.state.projects = PROJECTS.state.projects.filter((p) => p.id !== id);
    for (const sid of Object.keys(PROJECTS.state.chats)) if (PROJECTS.state.chats[sid] === id) delete PROJECTS.state.chats[sid];
    toast('Project removed', 'Its chats are kept, under Chats');
    render();
  }, () => {});
}

/* Edit project: a sheet with the name and the instructions. What is typed is
   kept in PROJECTS.edit as it is typed (the listener below), and drawn into
   the fields only when the sheet itself changes (saving, an error), so a
   repaint never throws typing away. */
/* A project by its id: the store's (`p…`) or a chat folder (`f…`), as {id, name, folder, instructions}. */
function projectAny(id) {
  if (id && id[0] === 'f') {
    const f = typeof FOLDERS !== 'undefined' ? folderById(FOLDERS.state, id) : null;
    return f ? {id: f.id, name: f.name, folder: '', instructions: f.instructions || ''} : null;
  }
  return PROJECTS.state.projects.find((x) => x.id === id) || null;
}

function projectEditOpen(id) {
  const p = projectAny(id);
  if (!p) return;
  const instructions = p.instructions || '';
  PROJECTS.edit = {id, name: p.name, instructions, shownName: p.name, shownInstructions: instructions, error: null, saving: false};
  S.overlay = 'pedit';
  render();
  const f = typeof document !== 'undefined' && document.getElementById('pedit-name');
  if (f) f.focus();
}

function projectEditRedraw(patch) {
  const e = PROJECTS.edit;
  if (!e) return;
  Object.assign(e, patch, {shownName: e.name, shownInstructions: e.instructions});
  S.overlay = 'pedit';
  render();
}

async function projectEditSave() {
  const e = PROJECTS.edit, api = projectsApi();
  if (!e || !api || e.saving) return;
  const name = String(e.name || '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (!name) { projectEditRedraw({error: 'A project name cannot be empty'}); return; }
  if ([...name].length > PROJECT_NAME_MAX) { projectEditRedraw({error: 'A project name is at most ' + PROJECT_NAME_MAX + ' characters'}); return; }
  if (e.instructions.length > PROJECT_INSTRUCTIONS_MAX) { projectEditRedraw({error: 'Instructions are at most ' + PROJECT_INSTRUCTIONS_MAX + ' characters'}); return; }
  if (e.id[0] === 'f') {
    const f = folderById(FOLDERS.state, e.id);
    if (!f || !folderRename(FOLDERS.state, e.id, name)) { projectEditRedraw({error: 'The project was not saved'}); return; }
    const text = e.instructions.trim();
    if (text) f.instructions = text; else delete f.instructions;
    saveFolders();
    PROJECTS.edit = null;
    if (S.overlay === 'pedit') S.overlay = null;
    render();
    return;
  }
  projectEditRedraw({saving: true, error: null});
  let res = null;
  try { res = await api.projectsSave({id: e.id, name, instructions: e.instructions}); } catch (err) { res = {ok: false, error: String(err && err.message || err)}; }
  if (PROJECTS.edit !== e) return;   // closed meanwhile
  const p = projectFromSave(res);
  if (!p) { projectEditRedraw({saving: false, error: (res && res.error) || 'The project was not saved'}); return; }
  const i = PROJECTS.state.projects.findIndex((x) => x.id === p.id);
  if (i >= 0) PROJECTS.state.projects[i] = p;
  PROJECTS.edit = null;
  if (S.overlay === 'pedit') S.overlay = null;
  render();
}

/** The Edit project sheet (S.overlay === 'pedit'), on the overlay layer. */
function projectEditHTML() {
  const e = PROJECTS.edit;
  if (!e) return '';
  const p = projectAny(e.id);
  const body = '<label class="sd-cap" for="pedit-name">Name</label>'
    + '<input id="pedit-name" class="tk-inp" maxlength="' + PROJECT_NAME_MAX + '" value="' + esc(e.shownName) + '"' + (e.saving ? ' disabled' : '') + '>'
    + (p && p.folder ? '<p class="sd-cap mono" title="' + esc(p.folder) + '">' + esc(p.folder) + '</p>' : '')
    + '<label class="sd-cap" for="pedit-instr">Instructions for every chat in this project</label>'
    + '<textarea id="pedit-instr" class="tk-inp sd-json" rows="8" maxlength="' + PROJECT_INSTRUCTIONS_MAX + '"'
      + ' placeholder="For example: answer in English, run the tests before you say it works."' + (e.saving ? ' disabled' : '') + '>' + esc(e.shownInstructions) + '</textarea>'
    + (e.error ? '<div class="tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(e.error) + '</span></div>' : '');
  return sheet('Edit project', body,
    '<span class="grow"></span><button class="btn btn-s sm" data-act="close">Cancel</button>'
    + '<button class="btn btn-p sm" data-act="psave:"' + (e.saving ? ' disabled' : '') + '>' + (e.saving ? '<span class="tk-spin"></span>' : '') + 'Save</button>',
    'sheet-project');
}

if (typeof document !== 'undefined') {
  document.addEventListener('input', (ev) => {
    const e = PROJECTS.edit, c = PROJECTS.create, t = ev.target;
    if (!t) return;
    if (c && t.id === 'pnew-name') c.name = t.value;
    else if (c && t.id === 'pnew-instr') c.instructions = t.value;
    if (!e) return;
    if (t.id === 'pedit-name') e.name = t.value;
    else if (t.id === 'pedit-instr') e.instructions = t.value;
  });
}

/** The act verbs this file owns (renderer.js act() hands them over). */
function projectAct(k, v) {
  if (k === 'pnew') { projectCreateOpen(v || null); return true; }
  if (k === 'pnewpick') { projectCreatePick(); return true; }
  if (k === 'pnewclear') { projectCreateRedraw({folder: ''}); return true; }
  if (k === 'pnewsave') { projectCreateSave(); return true; }
  if (k === 'pchat') { if (projectAny(v)) projectNewChat(v); return true; }
  if (k === 'ptoggle') { projectToggle(v); render(); if (typeof nameVisibleSessions === 'function') nameVisibleSessions(); return true; }
  if (k === 'pmore') { PROJECTS.showAll = PROJECTS.showAll !== true; render(); if (typeof nameVisibleSessions === 'function') nameVisibleSessions(); return true; }
  if (k === 'pdelask') {
    const p = projectAny(v);
    if (!p) return true;
    S.alert = {title: 'Remove project “' + p.name + '”?', msg: p.folder ? 'Its chats stay, under Chats. The folder on disk is not touched.' : 'Its chats stay, under Chats.', ok: 'Remove', act: 'pdel:' + v};
    render(); return true;
  }
  if (k === 'pdel') { projectRemove(v); return true; }
  if (k === 'pedit') { projectEditOpen(v); return true; }
  if (k === 'psave') { projectEditSave(); return true; }
  return false;
}

/** The Projects block of the sidebar: each project and its chats.
    W2: "New project" left the rows under New chat and is this header's small
    button, so the header is drawn whenever the projects store is there, with
    no projects too (the rail hides an empty block, shell.css).
    W2 QA (16.11): the chat folders are listed here too, as projects with no
    disk folder (projectItems orders both by their latest chat); past the
    first few, "Show N more projects" (folderListCut), the one holding the
    open chat always shown. A project's header takes a dragged chat. */
function projectsSidebarHTML(groups, folders) {
  if (!projectsSupported()) return '';
  const items = projectItems(groups || [], folders || []);
  const openSid = typeof S !== 'undefined' && S ? S.sessionId : null;
  const cut = folderListCut(items, openSid, PROJECTS.showAll === true);
  const toggle = cut.hidden > 0
    ? '<button class="loadmore" data-act="pmore:">Show ' + cut.hidden + ' more ' + (cut.hidden === 1 ? 'project' : 'projects') + '</button>'
    : PROJECTS.showAll === true && items.length > FOLDERS_SHOWN ? '<button class="loadmore" data-act="pmore:">Show fewer projects</button>' : '';
  const plus = typeof lucideIcon === 'function' ? lucideIcon('folderPlus') : ic('folder');
  return '<div class="sb-list sb-folders sb-projects' + (items.length ? '' : ' sb-projects-empty') + '" data-list="projects">'
    + '<div class="sb-list-head micro"><span>Projects</span>'
      + '<button class="iconbtn sb-add sb-pnew" data-act="pnew:" title="New project" aria-label="New project">' + plus + '</button></div>'
    + cut.shown.map((g) => {
      const folder = g.kind === 'folder';
      const shut = folder ? g.item.collapsed : projectCollapsed(g.id);
      const where = folder ? '' : ' · ' + g.item.folder;
      const newChat = g.name ? 'New chat in ' + g.name : 'New chat in this project';
      const fold = (folder ? 'ftoggle:' : 'ptoggle:') + g.id;
      /* Review of #62: the row is a container, not a button, so its controls
         are real buttons a screen reader lists: the fold toggle (chevron,
         name, count), then New chat, Edit and Remove beside it. The row
         takes a dragged chat (data-fdrop, chat-folders.js). */
      return '<div class="sb-folder sb-project' + (shut ? ' collapsed' : '') + '" ' + (folder ? 'data-folder' : 'data-project') + '="' + esc(g.id) + '">'
        + '<div class="sb-fhead sb-phead" data-fdrop="' + esc(g.id) + '"'
          + ' title="' + esc(g.name + where + ' · ' + g.rows.length + (g.rows.length === 1 ? ' chat' : ' chats')) + '">'
          + '<button type="button" class="sb-ftoggle" data-act="' + esc(fold) + '" aria-expanded="' + !shut + '">'
            + '<span class="sb-fchev">' + ic(shut ? 'chevR' : 'chevD') + '</span>'
            + '<span class="sb-fic">' + ic('folder') + '</span>'
            + '<span class="sb-fname">' + esc(g.name) + '</span>'
            + (g.rows.length ? '<span class="ct tnum">' + g.rows.length + '</span>' : '')
          + '</button>'
          + '<button type="button" class="sesmore iconbtn" data-act="pchat:' + esc(g.id) + '" title="' + esc(newChat) + '" aria-label="' + esc(newChat) + '">' + ic('plus') + '</button>'
          + '<button type="button" class="sesmore iconbtn" data-act="pedit:' + esc(g.id) + '" title="Edit project" aria-label="Edit project">' + ic('edit') + '</button>'
          + '<button type="button" class="sesmore iconbtn" data-act="pdelask:' + esc(g.id) + '" title="Remove project" aria-label="Remove project">' + ic('x') + '</button>'
        + '</div>'
        + (shut ? '' : g.rows.length ? g.rows.map(chatRow).join('') : '<div class="sb-empty sb-fempty">No chats yet. Start one with + or drag a chat here</div>')
        + '</div>';
    }).join('')
    + toggle
    + '</div>';
}

/** The chat's "Move to project" list (S.overlay === 'fpick'): every project, then No project and New project. */
function projectPickItems(sid) {
  const here = (FOLDERS.state.chats[sid]) || PROJECTS.state.chats[sid] || '';
  const items = projectItems(PROJECTS.state.projects.map((p) => ({project: p, rows: []})),
    FOLDERS.state.folders.map((f) => ({folder: f, rows: []})));
  return items.map((g) => ({act: 'fput:' + g.id + ':' + sid, label: g.name, icon: 'folder', on: g.id === here}))
    .concat(here ? [{act: 'fput::' + sid, label: 'No project', icon: 'x'}] : [])
    .concat([{act: 'pnew:' + sid, label: 'New project…', icon: 'plus', sep: items.length > 0}]);
}
