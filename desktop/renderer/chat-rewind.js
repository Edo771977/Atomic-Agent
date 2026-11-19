/* ---------------- ATO-1056 / ATO-1058: roll back, edit, fork ----------------
   Loaded before renderer.js; declares only.

   Three actions on a message, beside copy and retry:
   - "Roll back here" (a question): the chat goes back to just before it, and
     the files the agent's file tools changed since then are put back. A
     confirmation lists the files that will change and the messages that go.
     The question returns to the composer, as the terminal's /rewind does.
   - "Edit" (a question): the same confirmation with the files that will
     change, then the edited text is sent. When files change there are two
     ways: files and conversation (files: true), or the conversation only
     (files: false); with no file changes, one button and no file section.
   - "Fork from here" (a reply): a new chat with the history up to and
     including that reply; the original stays as it is.

   The agent does the work (POST /api/sessions/{id}/rewind[/preview], /fork):
   it names the question by how many questions come before it and its text,
   like "Regenerate" does (priorQuestions in renderer.js), and refuses a
   different one. Only changes made by the agent's own file tools can be put
   back: shell commands, git commands and Fusion workers are not undone, and
   the confirmation says so. */

/* ---- pure part (unit-tested in desktop/test/chat-rewind.test.mjs) ---- */

/** The question a message stands for: itself (a question), or the one its reply answers. */
function rewindQuestionFor(log, m) {
  if (!m || !Array.isArray(log)) return null;
  if (m.k === 'user') return m.steered ? null : m;
  if (m.k !== 'assistant') return null;
  for (let i = log.indexOf(m) - 1; i >= 0; i--) {
    const x = log[i];
    if (x && x.k === 'user' && !x.steered) return x;
  }
  return null;
}

const REWIND_REASON = {
  too_large: 'too large to keep a copy of',
  binary: 'not a text file',
  not_a_file: 'a folder, not a file',
  unreadable: 'could not be read',
};

const REWIND_TOOL_WORDS = [
  [(t) => t.indexOf('os.shell.') === 0, 'shell command', 'shell commands'],
  [(t) => t.indexOf('os.git.') === 0, 'git command', 'git commands'],
  [(t) => t === 'os.fs.archive.extract', 'archive extraction', 'archive extractions'],
  [(t) => t === 'fusion.delegate', 'Fusion run', 'Fusion runs'],
];

function rewindPlural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

/** A path as the confirmation shows it: relative to the chat's folder when inside it. */
function rewindPathLabel(path, workingDir) {
  const p = String(path || '');
  const wd = String(workingDir || '').replace(/[\\/]+$/, '');
  if (wd && (p.indexOf(wd + '/') === 0 || p.indexOf(wd + '\\') === 0)) return p.slice(wd.length + 1);
  return p;
}

/** What the confirmation says, from the agent's preview. */
function rewindSummary(preview, workingDir) {
  const p = preview || {};
  const removed = p.removed || {};
  const q = Number(removed.questions) || 0;
  const r = Number(removed.replies) || 0;
  const files = Array.isArray(p.files) ? p.files : [];
  const out = {
    removedText: rewindPlural(q, 'message of yours', 'messages of yours') + ' and ' + rewindPlural(r, 'reply', 'replies') + ' will be removed from this chat.',
    restore: files.filter((f) => f.action === 'restore').map((f) => rewindPathLabel(f.path, workingDir)),
    remove: files.filter((f) => f.action === 'delete').map((f) => rewindPathLabel(f.path, workingDir)),
    cannot: (Array.isArray(p.notRestorable) ? p.notRestorable : [])
      .map((f) => rewindPathLabel(f.path, workingDir) + ' (' + (REWIND_REASON[f.reason] || 'no copy was kept') + ')'),
    warnings: [],
  };
  if (p.incomplete) out.warnings.push('Some older file changes are no longer kept, so not every file can be put back.');
  const counts = new Map();
  for (const u of Array.isArray(p.uncovered) ? p.uncovered : []) {
    const words = REWIND_TOOL_WORDS.find(([match]) => match(String(u.tool || '')));
    if (!words) continue;
    counts.set(words, (counts.get(words) || 0) + (Number(u.count) || 0));
  }
  if (counts.size) {
    const list = [...counts].map(([[, one, many], n]) => rewindPlural(n, one, many));
    out.warnings.push('This part of the chat also ran ' + list.join(', ') + '. What they changed is not undone.');
  }
  out.warnings.push('Only files changed by the agent\'s own file tools are put back. Shell commands and Fusion workers are never undone, and edits you made to these files by hand since then will be lost.');
  return out;
}

/**
 * The confirm buttons of the sheet: [act, label, files flag]. Roll back sends
 * no flag (the agent's default puts files back). Edit offers both ways only
 * when files will really change; otherwise one button, conversation only.
 */
function rewindButtons(mode, summary) {
  if (mode !== 'edit') return [['rewind:go', 'Roll back', undefined]];
  const s = summary || {};
  const changes = (s.restore || []).length + (s.remove || []).length > 0;
  if (!changes) return [['rewind:go-chat', 'Send edited message', false]];
  return [['rewind:go-chat', 'Conversation only', false], ['rewind:go', 'Roll back files and conversation, then resend', true]];
}

/** Whether the sheet shows its file section (lists and file warnings). */
function rewindShowsFiles(mode, summary) {
  if (mode !== 'edit') return true;
  const s = summary || {};
  return (s.restore || []).length + (s.remove || []).length + (s.cannot || []).length > 0;
}

/** The words for the agent refusing (its 409 code). */
function rewindRefusalText(r) {
  const code = r && r.code;
  if (code === 'turn_in_progress') return 'The agent is still working in this chat. Wait for it to finish, then try again.';
  if (code === 'point_mismatch') return 'The chat changed on the agent side. Open it again, then try again.';
  if (code === 'point_compacted') return 'This part of the chat was already summarized, so it cannot be taken back.';
  if (code === 'session_not_found') return 'This chat is not saved yet.';
  if (code === 'restore_failed') return 'Some files could not be put back.';
  return (r && r.error) || 'The agent gave no reason. Nothing was changed.';
}

/* Issue #77: at most this many files that could not be put back are listed. */
const REWIND_FAILED_SHOWN = 8;
/* Issue #80: the most paths a rollback's `skip` may name (main/chat-rewind.ts REWIND_SKIP_CAP). */
const REWIND_SKIP_CAP = 1000;

/**
 * The sheet's words for a rollback that put back only some files (rewindAnswer
 * `restore`): which could not be, that the chat stayed, that the others stay
 * put back, and which button tries again.
 */
function rewindPartialHTML(partial, mode, workingDir, code) {
  const p = partial || {};
  if (code && code !== 'restore_failed') return rewindChangedHTML(p, workingDir);
  const failed = Array.isArray(p.failed) ? p.failed : [];
  const total = Math.max(Number(p.failedTotal) || 0, failed.length);
  const shown = failed.slice(0, REWIND_FAILED_SHOWN);
  const done = (Number(p.restoredTotal) || 0) + (Number(p.deletedTotal) || 0);
  let html = '<p class="sd-cap"><b>' + esc(total === 1 ? 'This file could not be put back' : 'These files could not be put back') + '</b></p>';
  if (shown.length) {
    html += '<div class="rows">' + shown.map((f) => '<div class="row"><span class="main"><span class="t">' + esc(rewindPathLabel(f.path, workingDir)) + '</span>'
      + (f.error ? '<span class="s">' + esc(f.error) + '</span>' : '') + '</span></div>').join('') + '</div>';
  }
  if (total > shown.length) html += '<p class="sd-cap">and ' + (total - shown.length) + ' more</p>';
  html += '<p class="sd-cap">The chat was left as it was. '
    + (done ? rewindPlural(done, 'file', 'files') + ' already put back stay put back. ' : '')
    + 'Press “Check again” to see what a rollback would change now, then confirm it.</p>';
  // Issue #77: a file that fails on every try would keep the sheet here for good: the way out.
  if (total && !rewindSkipFor(p)) {
    html += '<p class="sd-cap">Too many files could not be put back to leave each one alone. Press “Check again” to see what would change now.</p>';
  } else if (total) {
    const before = Array.isArray(REWIND.skip) ? REWIND.skip.length : 0;
    html += (before ? '<p class="sd-cap">Also left as they are: ' + rewindPlural(before, 'file', 'files') + ' from before.</p>' : '')
      // Issue #80: no promise beyond what the agent confirms (an older agent ignores `skip`).
      + '<p class="sd-cap">Or go ahead without them: this asks the agent to leave the files listed above as they are now. '
      + 'Their saved copies are dropped, so they cannot be put back later.</p>'
      + '<button class="btn btn-s sm" data-act="rewind:go-skip"' + (REWIND.busy ? ' disabled' : '') + '>'
      + esc(mode === 'edit' ? 'Roll back without these files, then resend' : 'Roll back without these files') + '</button>';
  }
  return html;
}

/** Paths as the sheet lists them: at most REWIND_FAILED_SHOWN, then "and N more". */
function rewindShortList(paths, total, workingDir, errors) {
  const shown = paths.slice(0, REWIND_FAILED_SHOWN);
  let html = shown.length ? '<div class="rows">' + shown.map((f, i) => '<div class="row"><span class="main"><span class="t">' + esc(rewindPathLabel(f, workingDir)) + '</span>'
    + (errors && errors[i] ? '<span class="s">' + esc(errors[i]) + '</span>' : '') + '</span></div>').join('') + '</div>' : '';
  if (total > shown.length) html += '<p class="sd-cap">and ' + (total - shown.length) + ' more</p>';
  return html;
}

/** Issue #77: a refusal (not restore_failed) that came after files were put back: which ones, and that the chat stayed. */
function rewindChangedHTML(p, workingDir) {
  const changed = (Array.isArray(p.restored) ? p.restored : []).concat(Array.isArray(p.deleted) ? p.deleted : []);
  const changedTotal = Math.max((Number(p.restoredTotal) || 0) + (Number(p.deletedTotal) || 0), changed.length);
  const failed = Array.isArray(p.failed) ? p.failed : [];
  const failedTotal = Math.max(Number(p.failedTotal) || 0, failed.length);
  let html = '';
  if (changedTotal) {
    html += '<p class="sd-cap"><b>' + esc((changedTotal === 1 ? 'This file was' : 'These files were') + ' already put back, but the chat was not rolled back') + '</b></p>'
      + rewindShortList(changed, changedTotal, workingDir);
  }
  if (failedTotal) {
    html += '<p class="sd-cap"><b>' + esc(failedTotal === 1 ? 'This file could not be put back' : 'These files could not be put back') + '</b></p>'
      + rewindShortList(failed.map((f) => f.path), failedTotal, workingDir, failed.map((f) => f.error));
  }
  return html;
}

/**
 * Issue #80: the paths a Continue would leave alone, or null when they cannot
 * all be named: more failed than the answer lists, or more than REWIND_SKIP_CAP.
 */
function rewindSkipFor(partial) {
  const p = partial || {};
  const failed = Array.isArray(p.failed) ? p.failed : [];
  if ((Number(p.failedTotal) || 0) > failed.length) return null;
  const skip = rewindSkipPaths(REWIND.skip, failed);
  return skip.length && skip.length <= REWIND_SKIP_CAP ? skip : null;
}

/** Issue #80: the paths a Continue leaves alone: those left alone before, then the newly failed ones, each once. */
function rewindSkipPaths(before, failed) {
  const out = [];
  for (const p of (Array.isArray(before) ? before : []).concat((Array.isArray(failed) ? failed : []).map((f) => f && f.path))) {
    if (typeof p === 'string' && p && !out.includes(p)) out.push(p);
  }
  return out;
}

/* ---- renderer side (globals from renderer.js, read at call time) ---- */

const REWIND = {supported: true, mode: null, id: null, sid: null, prior: 0, text: '', preview: null, loading: false, busy: false, error: null, partial: null, partialCode: null, skip: [], afterPartial: false, draft: ''};

function rewindReady() {
  return typeof BR !== 'undefined' && BR && BR.rewindPreview && REWIND.supported && S.agentSession && !S.busy && !S.pending;
}

/** The buttons for message `m`, drawn into its row of actions (msgActs). */
function rewindActsHTML(m) {
  if (!rewindReady() || !m || m.placeholder || !String(m.text || '').trim()) return '';
  const btn = (verb, icon, label) => '<button class="msgact" data-rw="1" data-act="rewind:' + verb + ':' + esc(m.id)
    + '" title="' + label + '" aria-label="' + label + '">' + ic(icon) + '</button>';
  if (m.k === 'user') return m.steered ? '' : btn('edit', 'edit', 'Edit') + btn('back', 'undo', 'Roll back here');
  if (m.k === 'assistant' && rewindQuestionFor(S.log, m)) return btn('fork', 'branch', 'Fork from here');
  return '';
}

/** `rewind:<verb>:<message id>` from act(): back · edit · fork · go · go-chat (edit, conversation only) · go-skip · recheck (issue #80). */
function rewindAct(v) {
  const colon = v.indexOf(':');
  const verb = colon < 0 ? v : v.slice(0, colon);
  const id = colon < 0 ? '' : v.slice(colon + 1);
  if (verb === 'go') return rewindConfirm(REWIND.mode === 'edit' ? true : undefined);
  if (verb === 'go-chat') return rewindConfirm(false);
  if (verb === 'recheck') return rewindRecheck();
  // Issues #77 / #80: only from a partial restore's notice: the same rollback, leaving alone exactly the
  // files it listed (and those left alone before in this sheet). Never "accept failed": that plans every file again.
  if (verb === 'go-skip') {
    if (!REWIND.partial || REWIND.partialCode !== 'restore_failed') return;
    const skip = rewindSkipFor(REWIND.partial);
    if (!skip) return;   // not offered (rewindPartialHTML)
    return rewindConfirm(REWIND.mode === 'edit' ? true : undefined, skip);
  }
  if (verb === 'back' || verb === 'edit' || verb === 'fork') rewindStart(verb, id);
}

function rewindStart(mode, id) {
  const m = S.log.find((x) => x.id === id);
  const q = rewindQuestionFor(S.log, m);
  if (!q || !rewindReady()) return;
  Object.assign(REWIND, {mode, id: q.id, sid: S.agentSession, prior: priorQuestions(q), text: String(q.text || ''),
    preview: null, error: null, partial: null, partialCode: null, skip: [], afterPartial: false, busy: false, loading: mode !== 'fork', draft: attToEditor(String(q.text || ''))});
  if (mode === 'fork') { rewindFork(); return; }
  S.overlay = 'rewind';
  render();
  rewindLoadPreview();
}

async function rewindLoadPreview() {
  const sid = REWIND.sid;
  const r = await BR.rewindPreview(sid, REWIND.prior, REWIND.text).catch((err) => ({ok: false, supported: true, error: String(err)}));
  if (REWIND.sid !== sid || S.overlay !== 'rewind') return;
  REWIND.loading = false;
  if (r && r.supported === false) { REWIND.supported = false; S.overlay = null; render(); toast('Not available', 'This agent version cannot roll a chat back. Update Atomic Agent.', 'bad'); return; }
  if (!r || !r.ok) REWIND.error = rewindRefusalText(r);
  else REWIND.preview = r.data;
  render();
}

/** Issue #80: "Check again" after a partial restore: drop the old preview and the notice, and show a fresh one. */
function rewindRecheck() {
  if (!REWIND.afterPartial || REWIND.busy) return;
  Object.assign(REWIND, {partial: null, partialCode: null, afterPartial: false, error: null, skip: [], preview: null, loading: true});
  render();
  return rewindLoadPreview();
}

function rewindSheetHTML() {
  const edit = REWIND.mode === 'edit';
  let body = '';
  if (edit) {
    body += '<p class="sd-cap">Change your message. Sending it takes the chat back to just before it, then sends the new text.</p>'
      + '<textarea id="rw-edit" class="tk-inp" rows="5" spellcheck="true">' + esc(REWIND.draft) + '</textarea>';
  }
  if (REWIND.error) body += '<div class="tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(REWIND.error) + '</span></div>';
  if (REWIND.partial) body += rewindPartialHTML(REWIND.partial, REWIND.mode, typeof WORKSPACE === 'string' ? WORKSPACE : '', REWIND.partialCode);
  if (REWIND.loading) body += '<div class="tk-empty"><span class="tk-spin"></span><p>Checking what will change…</p></div>';
  const s = REWIND.preview ? rewindSummary(REWIND.preview, typeof WORKSPACE === 'string' ? WORKSPACE : '') : null;
  if (s && !rewindShowsFiles(REWIND.mode, s)) body += '<p class="sd-cap">' + esc(s.removedText) + '</p>';
  else if (s) {
    const list = (title, items) => items.length
      ? '<p class="sd-cap"><b>' + esc(title) + '</b></p><div class="rows">' + items.map((t) => '<div class="row"><span class="main"><span class="t">' + esc(t) + '</span></span></div>').join('') + '</div>'
      : '';
    body += '<p class="sd-cap">' + esc(s.removedText) + '</p>';
    body += (s.restore.length || s.remove.length) ? '' : '<p class="sd-cap">No files will change.</p>';
    body += list('Put back as they were', s.restore) + list('Removed (the agent created them)', s.remove) + list('Cannot be put back', s.cannot);
    body += s.warnings.map((w) => '<div class="tk-notice tk-notice--amber">' + ic('alert') + '<span class="grow">' + esc(w) + '</span></div>').join('');
  }
  const disabled = REWIND.loading || REWIND.busy || (!REWIND.preview && !REWIND.afterPartial);
  // Issue #80: after a partial restore the files on disk are not what the preview showed, so the only
  // way to try again is "Check again": a fresh preview, then the normal confirm. This also keeps
  // "Conversation only" away (issue #77): it would cut the chat and drop the saved copies.
  // It holds for every later refusal in this sheet too (afterPartial), not only while the notice is up.
  const buttons = REWIND.afterPartial ? [['rewind:recheck', 'Check again']] : rewindButtons(REWIND.mode, s);
  // The last button is the primary one.
  const foot = buttons.map(([a, label], i) => {
    const kind = i < buttons.length - 1 ? 'btn-s' : edit ? 'btn-p' : 'btn-df';
    return '<button class="btn ' + kind + ' sm" data-act="' + a + '"' + (disabled ? ' disabled' : '') + '>'
      + (REWIND.busy && i === buttons.length - 1 ? '<span class="tk-spin"></span>' : '') + esc(label) + '</button>';
  }).join('');
  return sheet(edit ? 'Edit message' : 'Roll back to this message', body,
    '<span class="grow"></span><button class="btn btn-s sm" data-act="close">Cancel</button>' + foot, 'sheet-rewind');
}

/**
 * `files`: undefined (roll back, the agent's default), true or false (edit).
 * `skip`: the paths to leave as they are, only from the partial-restore
 * notice (issue #80). Another partial restore shows the notice again; nothing
 * is retried on its own.
 */
async function rewindConfirm(files, skip) {
  if (REWIND.busy || !REWIND.preview) return;
  // Issue #80: once a partial restore happened in this sheet, only Continue (skip) sends, and only from the
  // notice; anything else checks again first (rewindRecheck), whatever the later answers were.
  if (REWIND.afterPartial && !(REWIND.partial && Array.isArray(skip) && skip.length)) return;
  const edit = REWIND.mode === 'edit';
  const box = document.getElementById('rw-edit');
  const draft = edit ? String(box ? box.value : REWIND.draft) : '';
  if (edit && !draft.trim()) { REWIND.error = 'The message is empty.'; render(); return; }
  const entry = $('#entry');
  const typed = String((entry ? entry.value : S.draft) || '').trim();
  if (typed || (typeof ATT !== 'undefined' && ATT.items.length)) { REWIND.error = 'Your draft is in the way. Send or clear the composer first.'; render(); return; }
  const sid = REWIND.sid;
  REWIND.busy = true; REWIND.error = null; REWIND.partial = null; render();
  const skipping = Array.isArray(skip) && skip.length ? skip : null;
  if (skipping) REWIND.skip = skipping;
  const args = skipping ? [sid, REWIND.prior, REWIND.text, files, skipping] : [sid, REWIND.prior, REWIND.text, files];
  const r = await BR.rewind(...args).catch((err) => ({ok: false, supported: true, error: String(err)}));
  REWIND.busy = false;
  // Issue #77: a partial restore, or a refusal after files were put back, left the chat as it was;
  // the sheet says which files and stays open.
  if (!r || !r.ok) {
    REWIND.error = rewindRefusalText(r); REWIND.partial = r && r.restore ? r.restore : null; REWIND.partialCode = r && r.code;
    if (REWIND.partial) REWIND.afterPartial = true;   // cleared only by Check again or by opening the sheet again
    render(); return;
  }
  S.overlay = null;
  await openSession(sid);
  if (S.agentSession !== sid) return;
  const d = r.data || {};
  const failed = Array.isArray(d.failed) ? d.failed : [];
  S.draft = edit ? draft : attToEditor(String(d.text || REWIND.text));
  const e = $('#entry');
  if (e) { e.value = S.draft; autosize(e); e.focus(); }
  refreshSend();
  const n = (d.restored || []).length + (d.deleted || []).length;
  // Issue #80: the files the agent says it left as they are (`skip`).
  const wd = typeof WORKSPACE === 'string' ? WORKSPACE : '';
  const skipped = Array.isArray(d.skipped) ? d.skipped.filter((p) => typeof p === 'string' && p) : [];
  const shown = skipped.slice(0, REWIND_FAILED_SHOWN).map((p) => rewindPathLabel(p, wd));
  // An agent that does not answer `skipped` may not know `skip` and may have put those files back too.
  const unconfirmed = !!skipping && !Array.isArray(d.skipped);
  const left = unconfirmed ? 'Check those files: your agent did not confirm it left those files alone. '
    : skipped.length ? 'Left as they are: ' + shown.join(', ') + (skipped.length > shown.length ? ' and ' + (skipped.length - shown.length) + ' more' : '') + '. ' : '';
  toast(edit ? 'Message edited' : 'Rolled back', (n ? rewindPlural(n, 'file', 'files') + ' put back. ' : '') + left
    + (failed.length ? failed.length + ' could not be written: ' + failed.map((f) => f.path).join(', ') : ''), failed.length || unconfirmed ? 'bad' : undefined);
  if (edit) submit();
}

async function rewindFork() {
  const sid = REWIND.sid;
  const r = await BR.forkSession(sid, REWIND.prior, REWIND.text).catch((err) => ({ok: false, supported: true, error: String(err)}));
  if (r && r.supported === false) { REWIND.supported = false; render(); toast('Not available', 'This agent version cannot fork a chat. Update Atomic Agent.', 'bad'); return; }
  if (!r || !r.ok || !r.data || !r.data.id) { toast("Couldn't fork", rewindRefusalText(r), 'bad'); return; }
  await refreshSessions();
  await openSession(r.data.id);
  toast('Forked', 'A new chat with the history up to here. The original is unchanged.');
}

/* The edit box keeps its text across repaints while it is not focused. */
if (typeof document !== 'undefined') {
  document.addEventListener('input', (e) => { if (e.target && e.target.id === 'rw-edit') REWIND.draft = e.target.value; });
}

if (typeof module !== 'undefined') module.exports = {REWIND_SKIP_CAP, rewindQuestionFor, rewindPathLabel, rewindPartialHTML, rewindSummary, rewindRefusalText, rewindButtons, rewindShowsFiles,
  REWIND, rewindSheetHTML, rewindAct, rewindConfirm};
