/* ---------------- Issue #109: the Fusion projects list ----------------
   Loaded before renderer.js; declares only, and reads renderer.js globals
   (BR, S, render, sheet, esc, toast, openSession, refreshSessions) at call
   time, as chat-projects.js does. The pure part (rows, groups, the sheet's
   body, the answers) is unit-tested in test/fusion-projects.test.mjs.

   Every Fusion project this computer knows (the agent's `projects list`:
   GET /api/projects through main, agent:fusionProjects), one row each: its
   name, folder, the gate waiting for you, what happens next, the last
   activity and the spend. A folder that is missing, damaged or of a newer
   version is a row too, said as such with the agent's note and what to do.
   Rows are grouped by attention zone (issue #121, the agent's `zone`:
   src/session/project-attention.ts), what needs you first, the most recent
   activity first within a zone.

   Opened from the Projects header in the sidebar (the Fusion button beside
   New project, chat-projects.js). Open resumes the project as
   `atag project resume` does: the agent opens the newest chat on that
   folder's project, or a new one, and the window shows it, its card on the
   gate that waits. Forget asks first and takes the folder off the list
   only; nothing on disk is touched.

   Model text (names, notes) goes through esc(): the sheet is markup. */

const FPJ_ZONES = ['needs-you', 'problem', 'in-progress', 'idle', 'done'];
const FPJ_ZONE_LABEL = {'needs-you': 'Needs you', problem: 'Problem', 'in-progress': 'In progress', idle: 'Idle', done: 'Done'};
const FPJ_STATUS = {
  missing: {badge: 'Folder missing', todo: 'The folder is not there. Put it back to work on it again, or Forget it if it is gone for good.'},
  damaged: {badge: 'Damaged', todo: 'Its project.json could not be read; it was left as it is. Fix or restore it (version control, a backup), then reload the list.'},
  unsupported: {badge: 'Unsupported', todo: 'It was written by a newer Atomic Agent. Update Atomic Agent to open it.'},
  unreadable: {badge: 'Unreadable', todo: 'It could not be read now (permissions, a disk not mounted). Check the folder, then reload the list.'},
};
const FPJ = {loading: false, rows: [], registryProblem: null, error: null, unsupported: false, busy: null, forget: null, seq: 0, visit: 0};

const fpjStr = (v) => (typeof v === 'string' ? v : '');

/** The zone of a row: the agent's, or for an older agent's row, a guess from its status. */
function fpjZone(row) {
  if (row && FPJ_ZONES.includes(row.zone)) return row.zone;
  return row && row.status === 'ok' ? 'in-progress' : 'problem';
}

function fpjAgo(at, now) {
  const s = Math.max(0, now - at) / 1000;
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
  const h = Math.floor(m / 60); if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  const d = Math.floor(h / 24); if (d === 1) return 'yesterday';
  return d + ' days ago';
}

/** One row as the sheet draws it. */
function fpjRow(row, now) {
  const folder = fpjStr(row && row.folder);
  const base = folder.split(/[\\/]/).filter(Boolean).pop() || folder;
  const zone = fpjZone(row);
  if (!row || row.status !== 'ok') {
    const st = FPJ_STATUS[row && row.status] || FPJ_STATUS.unreadable;
    return {folder, name: base, zone, ok: false, badge: st.badge, lines: [], notes: row && row.problem ? [fpjStr(row.problem)] : [], todo: st.todo,
      canResume: false, canForget: true, updatedAt: null};
  }
  const gate = fpjStr(row.gate);
  const lines = [
    !gate || gate === 'none' ? 'Nothing waits for you' : 'Waiting on you: ' + (gate === 'brief' || gate === 'plan' ? 'the ' + gate : gate),
    'Next: ' + (fpjStr(row.next) || 'unknown'),
  ];
  if (typeof row.updatedAt === 'number') lines.push('Last activity: ' + fpjAgo(row.updatedAt, now));
  lines.push('Spend: ' + (typeof row.spentUsd === 'number' ? '$' + row.spentUsd.toFixed(2) : 'no recorded runs'));
  return {folder, name: fpjStr(row.name) || base, zone, ok: true, badge: FPJ_ZONE_LABEL[zone], lines,
    notes: (Array.isArray(row.notices) ? row.notices : []).map(fpjStr).filter(Boolean), todo: '',
    canResume: true, canForget: true, updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : null};
}

/** Rows by zone, in the core's order, the most recent activity first; zones with no row left out. */
function fpjGroups(rows, now) {
  const models = (Array.isArray(rows) ? rows : []).map((r) => fpjRow(r, now));
  return FPJ_ZONES.map((zone) => ({
    zone, label: FPJ_ZONE_LABEL[zone],
    rows: models.filter((m) => m.zone === zone).sort((a, b) => (b.updatedAt ?? -Infinity) - (a.updatedAt ?? -Infinity) || 0),
  })).filter((g) => g.rows.length > 0);
}

/** The sheet's body. `state`: {rows, loading?, error?, unsupported?, registryProblem?, busy?}; row actions name the row's index in draw order. */
function fpjBodyHTML(state, now, escape) {
  const notice = (text, red) => '<div class="tk-notice ' + (red ? 'tk-notice--red' : 'tk-notice--amber') + '"><span class="grow">' + escape(text) + '</span></div>';
  if (state.unsupported) return notice('This agent cannot list Fusion projects; update it.', true);
  let html = '';
  if (state.error) html += notice('The list could not be read: ' + state.error, true);
  if (state.registryProblem) html += notice('The projects list could not be read and was left as it is: ' + state.registryProblem, true);
  if (state.loading && !(state.rows || []).length) return html + '<p class="sd-cap">Loading…</p>';
  const groups = fpjGroups(state.rows, now);
  if (!groups.length) {
    return html + (state.registryProblem || state.error ? '' : '<p class="sd-cap">No Fusion projects yet. A Fusion project starts when a chat’s director drafts a brief.</p>');
  }
  let i = 0;
  for (const g of groups) {
    html += '<section class="fpj-zone fpj-zone--' + g.zone + '"><h3 class="fpj-zhead micro"><span>' + escape(g.label) + '</span> <span class="ct tnum">' + g.rows.length + '</span></h3>';
    for (const r of g.rows) {
      const at = i++;
      const busy = state.busy === r.folder;
      html += '<div class="fpj-row' + (r.ok ? '' : ' fpj-row--bad') + '">'
        + '<div class="fpj-top"><span class="fpj-name">' + escape(r.name) + '</span>'
          + '<span class="fpj-badge fpj-badge--' + (r.ok ? r.zone : 'bad') + '">' + escape(r.badge) + '</span></div>'
        + '<div class="fpj-folder mono" title="' + escape(r.folder) + '">' + escape(r.folder) + '</div>'
        + r.lines.map((l) => '<div class="fpj-line">' + escape(l) + '</div>').join('')
        + r.notes.map((n) => '<div class="fpj-note">' + escape(n) + '</div>').join('')
        + (r.todo ? '<div class="fpj-todo">' + escape(r.todo) + '</div>' : '')
        + '<div class="fpj-acts">'
          + (r.canResume ? '<button class="btn btn-p sm" data-act="fpjresume:' + at + '"' + (state.busy || state.loading ? ' disabled' : '') + '>' + (busy ? '<span class="tk-spin"></span>' : '') + 'Resume</button>' : '')
          + (r.canForget ? '<button class="btn btn-s sm" data-act="fpjforgetask:' + at + '"' + (state.busy || state.loading ? ' disabled' : '') + '>Forget…</button>' : '')
        + '</div></div>';
    }
    html += '</section>';
  }
  return html;
}

/** The rows in the order the sheet draws them (the index its actions carry). */
function fpjDrawn(rows, now) {
  return fpjGroups(rows, now).flatMap((g) => g.rows);
}

/** The question before Forget (S.alert). */
function fpjForgetAlert(model) {
  return {title: 'Forget the Fusion project “' + model.name + '”?',
    msg: model.folder + ' leaves this list. Its files are not touched: a chat opened in that folder lists it again.', ok: 'Forget', act: 'fpjforget:'};
}

/** main's answer to agent:fusionProjects, as the sheet's state. */
function fpjListOutcome(res) {
  if (!res || res.supported === false) return {rows: [], unsupported: true};
  if (!res.ok) return {rows: [], error: res.error || 'unknown error'};
  return {rows: Array.isArray(res.projects) ? res.projects : [], registryProblem: res.registryProblem || null};
}

/** main's answer to agent:fusionProjectResume: the chat to open, or why not. */
function fpjResumeOutcome(res) {
  if (!res || res.supported === false) return {error: 'This agent cannot resume Fusion projects; update it.'};
  if (!res.ok || typeof res.sessionId !== 'string' || !res.sessionId) return {error: (res && res.error) || 'The Fusion project could not be opened'};
  return {sessionId: res.sessionId, created: res.created === true};
}

/* ---------- the window (renderer.js globals at call time) ---------- */

function fpjApi() {
  return typeof BR !== 'undefined' && BR && typeof BR.fusionProjects === 'function' ? BR : null;
}

async function fusionProjectsLoad() {
  const api = fpjApi();
  if (!api) return;
  const seq = ++FPJ.seq;
  FPJ.loading = true; FPJ.error = null;
  render();
  let res;
  try { res = await api.fusionProjects(); } catch (e) { res = {supported: true, ok: false, error: String(e && e.message || e)}; }
  if (seq !== FPJ.seq) return;
  const out = fpjListOutcome(res);
  Object.assign(FPJ, {loading: false, rows: out.rows, registryProblem: out.registryProblem || null, error: out.error || null, unsupported: !!out.unsupported});
  render();
}

function fusionProjectsOpen() {
  if (!fpjApi()) return;
  FPJ.visit++;
  S.overlay = 'fprojects';
  void fusionProjectsLoad();
}

/** The Fusion projects sheet (S.overlay === 'fprojects'). */
function fusionProjectsHTML() {
  return sheet('Fusion projects', fpjBodyHTML(FPJ, Date.now(), esc),
    '<span class="grow sd-cap">Grouped by what needs you. Forget only takes a folder off this list.</span>'
    + '<button class="btn btn-s sm" data-act="fpjreload:"' + (FPJ.loading || FPJ.busy ? ' disabled' : '') + '>Reload</button>'
    + '<button class="btn btn-p sm" data-act="close">Done</button>',
    'sheet-fprojects');
}

async function fusionProjectResume(model) {
  const api = fpjApi();
  if (!api || FPJ.busy || FPJ.loading) return;
  // As New project: a chat that runs a turn is not left from here.
  if (S.busy) { if (typeof restartRefusedToast === 'function') restartRefusedToast({here: true, title: ''}); return; }
  const visit = FPJ.visit, session = S.sessionId;
  const stillHere = () => S.overlay === 'fprojects' && FPJ.visit === visit && S.sessionId === session;
  FPJ.busy = model.folder; render();
  let res;
  try { res = await api.fusionProjectResume(model.folder); } catch (e) { res = {supported: true, ok: false, error: String(e && e.message || e)}; }
  const out = fpjResumeOutcome(res);
  if (out.error) { FPJ.busy = null; toast('Could not open “' + model.name + '”', out.error, 'bad'); render(); void fusionProjectsLoad(); return; }
  if (typeof PCARD !== 'undefined' && PCARD && Object.prototype.hasOwnProperty.call(res, 'view')) {
    PCARD.onFrame({sessionId: out.sessionId, view: res.view});
  }
  try {
    if (out.created && typeof refreshSessions === 'function') await refreshSessions();
    if (stillHere()) {
      S.overlay = null;
      await openSession(out.sessionId);
      if (S.agentSession === out.sessionId && typeof PCARD !== 'undefined' && PCARD) PCARD.show();
    }
  } catch (e) {
    toast('Could not open “' + model.name + '”', String(e && e.message || e), 'bad');
  } finally {
    FPJ.busy = null; render();
  }
}

async function fusionProjectForget(folder) {
  const api = fpjApi();
  if (!api || !folder || FPJ.busy) return;
  FPJ.busy = folder; render();
  let res;
  try { res = await api.fusionProjectForget(folder); } catch (e) { res = {supported: true, ok: false, error: String(e && e.message || e)}; }
  FPJ.busy = null;
  if (!res || res.supported === false || !res.ok) toast('Could not forget the Fusion project', (res && res.error) || 'This agent cannot; update it.', 'bad');
  else toast('Fusion project forgotten', 'Its folder and files are kept');
  void fusionProjectsLoad();
}

/** The act verbs this file owns (renderer.js act() hands them over, after closing what was open). */
function fpjAct(k, v) {
  const model = () => !FPJ.loading && !FPJ.busy && /^\d+$/.test(v) ? fpjDrawn(FPJ.rows, Date.now())[Number(v)] || null : null;
  if (k === 'fpjopen') { fusionProjectsOpen(); return true; }
  if (k === 'fpjreload') { S.overlay = 'fprojects'; if (!FPJ.busy) void fusionProjectsLoad(); else render(); return true; }
  if (k === 'fpjresume') { const m = model(); S.overlay = 'fprojects'; if (m && m.canResume) void fusionProjectResume(m); else render(); return true; }
  if (k === 'fpjforgetask') {
    const m = model();
    if (!m) { S.overlay = 'fprojects'; render(); return true; }
    FPJ.forget = m.folder;
    S.alert = fpjForgetAlert(m);
    render(); return true;
  }
  if (k === 'fpjforget') { const folder = FPJ.forget; FPJ.forget = null; if (folder) { S.overlay = 'fprojects'; void fusionProjectForget(folder); } return true; }
  return false;
}

if (typeof module !== 'undefined') {
  module.exports = {FPJ_ZONES, FPJ_ZONE_LABEL, fpjZone, fpjAgo, fpjRow, fpjGroups, fpjBodyHTML, fpjDrawn, fpjForgetAlert, fpjListOutcome, fpjResumeOutcome};
}
