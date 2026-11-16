/* ---------------- Issue #39: the fusion project card ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/project-card.test.mjs).

   A chat that runs the project flow (its first request sent
   X-Atomic-Project: 1, see agent-client.ts) stops at three gates: the
   brief, the plan (who does each task, at what estimated cost and time)
   and every finished milestone. The agent sends each gate as a
   ProjectGateView (src/session/project-gate-view.ts) in a `project_gate`
   frame, on /api/events and in the chat stream; main hands both on as
   `agent:project` {sessionId, view}. GET /api/project?session= reads one
   chat's view when the chat is opened.

   The card draws only the newest version of a chat's gate, and only the
   buttons in view.allowedVerdicts. A plan row's worker and reviewer are
   picked only among the row's selectableWorkers / selectableReviewers. A
   decision goes back as {session, gate, version, verdict, edits?} with
   gate and version copied from the view (POST /api/project/decision);
   when the answer carries continue_message, the window sends it as the
   chat's next message, because the agent never continues by itself.

   Drawn with createElement / textContent and addEventListener only: the
   brief, task titles, reasons and summaries are model text and never go
   through innerHTML (the page's CSP allows no inline handlers anyway). */

const PC_NOTE_MAX = 2000;

/* The core's own sentences (src/session/project-gate-text.ts); test/project-card.test.mjs keeps them equal. */
const PC_WRITE_SCOPE_NOTE = "Approving lets these tasks write in this chat's folder (the session's working directory); a write outside it still asks.";
const PC_PLAN_UNTRUSTED = "⚠ The plan was drafted after outside content entered the chat. Check its tasks and workers before approving: approving lets them run without asking again.";
const PC_BRIEF_UNTRUSTED = '⚠ The brief was drafted after outside content entered the chat. Read it before approving.';

const PC_MARK = {planned: '·', approved: '▸', in_progress: '◐', done: '✓', failed: '✕', reviewed: '✔'};

const pcStr = (v) => (typeof v === 'string' ? v : '');
const pcList = (v) => (Array.isArray(v) ? v : []);
const pcNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function pcUsd(n) {
  if (n === null || n === undefined) return 'cost unknown';
  return n > 0 && n < 0.01 ? '<$0.01' : '$' + n.toFixed(2);
}

function pcDuration(ms) {
  if (ms === null || ms === undefined) return 'time unknown';
  const s = Math.round(ms / 1000);
  if (s < 60) return '~' + s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return '~' + m + 'm' + (s % 60 === 0 ? '' : String(s % 60).padStart(2, '0') + 's');
  return '~' + Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
}

/** A gate that waits on the person: something to decide, at a version. */
function pcOpen(view) {
  return !!(view && view.gate && view.gate.kind !== 'none' && typeof view.version === 'number'
    && pcList(view.allowedVerdicts).length > 0 && !view.cancelled);
}

/* ---------- the newest view per chat ---------- */

/** Keeps one view per chat: never an older version than the one drawn or closed. */
function pcStore() {
  const views = new Map();
  const closed = new Map();   // sid → the version a closed gate had
  return {
    get: (sid) => views.get(sid) || null,
    /** A `{sessionId, view}` frame or read. Answers whether what the chat's card draws changed. */
    put(sid, view) {
      if (!sid || !view || typeof view !== 'object' || view.schema !== 1) return false;
      const prev = views.get(sid) || null;
      const v = pcNum(view.version);
      if (!pcOpen(view)) {
        if (!prev) return false;
        if (v !== null && prev.version > v) return false;   // a late copy of an older state
        closed.set(sid, Math.max(prev.version, v || 0));
        views.delete(sid);
        return true;
      }
      if (prev && prev.version > v) return false;
      if (closed.has(sid) && v <= closed.get(sid)) return false;
      if (prev && prev.version === v && JSON.stringify(prev) === JSON.stringify(view)) return false;
      views.set(sid, view);
      return true;
    },
    drop(sid) { return views.delete(sid); },
    clear() { views.clear(); closed.clear(); },
  };
}

/* ---------- state and reducer ---------- */

/** The card's state for one chat's view. `mode`: view | edit (plan rows) | correct (milestone note). */
function pcInitial(view) {
  return {view: view || null, mode: 'view', picks: {}, note: '', busy: false, error: null, notice: null};
}

function pcRows(view) {
  return pcList(view && view.plan && view.plan.rows);
}

/** The worker options for a row: its selectable workers, its current one first when not among them. */
function pcWorkerOptions(row) {
  const list = pcList(row.selectableWorkers).filter((w) => typeof w === 'string');
  return list.includes(row.worker) ? list : [row.worker].concat(list);
}

/** The reviewer options: the selectable ones (its current one first when not among them), then null (no review). */
function pcReviewerOptions(row) {
  const list = pcList(row.selectableReviewers).filter((w) => typeof w === 'string');
  const out = row.reviewer !== null && row.reviewer !== undefined && !list.includes(row.reviewer) ? [row.reviewer].concat(list) : list.slice();
  out.push(null);
  return out;
}

function pcPick(state, taskId) {
  const row = pcRows(state.view).find((r) => r.taskId === taskId);
  if (!row) return null;
  const p = state.picks[taskId] || {};
  return {worker: 'worker' in p ? p.worker : row.worker, reviewer: 'reviewer' in p ? p.reviewer : (row.reviewer === undefined ? null : row.reviewer)};
}

function pcReduce(state, action) {
  const s = Object.assign({}, state);
  switch (action.type) {
    case 'view': {
      const next = action.view || null;
      const moved = !s.view || !next || s.view.version !== next.version
        || JSON.stringify(s.view.gate) !== JSON.stringify(next.gate);
      if (!moved) return Object.assign(s, {view: next});
      const wasEditing = s.mode !== 'view' && (Object.keys(s.picks).length > 0 || s.note.trim());
      return Object.assign(pcInitial(next), {
        notice: action.notice || (wasEditing && next ? 'The project changed while you were editing (now version ' + next.version + '); your changes were set aside.' : null),
      });
    }
    case 'edit':
      if (!s.view || s.view.gate.kind !== 'plan' || !pcList(s.view.allowedVerdicts).includes('edit')) return s;
      return Object.assign(s, {mode: 'edit', error: null, notice: null});
    case 'correct':
      if (!s.view || s.view.gate.kind !== 'milestone' || !pcList(s.view.allowedVerdicts).includes('edit')) return s;
      return Object.assign(s, {mode: 'correct', error: null, notice: null});
    case 'back':
      return Object.assign(s, {mode: 'view', picks: {}, note: '', error: null});
    case 'worker': {
      const row = pcRows(s.view).find((r) => r.taskId === action.taskId);
      if (s.mode !== 'edit' || !row || !pcWorkerOptions(row).includes(action.worker)) return s;
      const p = Object.assign({}, s.picks[row.taskId]);
      if (action.worker === row.worker) delete p.worker; else p.worker = action.worker;
      return pcSetPick(s, row.taskId, p);
    }
    case 'reviewer': {
      const row = pcRows(s.view).find((r) => r.taskId === action.taskId);
      const value = action.reviewer === undefined ? null : action.reviewer;
      if (s.mode !== 'edit' || !row || !pcReviewerOptions(row).includes(value)) return s;
      const p = Object.assign({}, s.picks[row.taskId]);
      if (value === (row.reviewer === undefined ? null : row.reviewer)) delete p.reviewer; else p.reviewer = value;
      return pcSetPick(s, row.taskId, p);
    }
    case 'note':
      return Object.assign(s, {note: String(action.note || '').slice(0, PC_NOTE_MAX)});
    case 'sending':
      return Object.assign(s, {busy: true, error: null, notice: null});
    case 'failed':
      return Object.assign(s, {busy: false, error: action.error || 'The decision did not go through'});
    case 'notice':
      return Object.assign(s, {busy: false, notice: action.notice || null});
    default:
      return s;
  }
}

function pcSetPick(s, taskId, p) {
  const picks = Object.assign({}, s.picks);
  if (Object.keys(p).length) picks[taskId] = p; else delete picks[taskId];
  return Object.assign(s, {picks, error: null});
}

/** The changed rows of an edit, as `edits.rows`. */
function pcEditRows(state) {
  const out = [];
  for (const row of pcRows(state.view)) {
    const p = state.picks[row.taskId];
    if (!p) continue;
    const r = {taskId: row.taskId};
    if ('worker' in p) r.worker = p.worker;
    if ('reviewer' in p) r.reviewer = p.reviewer;
    out.push(r);
  }
  return out;
}

/**
 * The POST body for `verdict` in this state, or {error}. `edit` sends the
 * changed rows at the plan and the note at a milestone; the brief's edit is
 * not sent from the card (the person says what to change in the chat).
 */
function pcDecision(state, sid, verdict) {
  const view = state.view;
  if (!pcOpen(view)) return {error: 'Nothing in this project waits for you'};
  if (!pcList(view.allowedVerdicts).includes(verdict)) return {error: 'This gate does not take that'};
  const body = {session: sid, gate: view.gate.kind === 'milestone' ? {kind: 'milestone', id: view.gate.id} : {kind: view.gate.kind}, version: view.version, verdict};
  if (verdict === 'approve' && pcHardViolations(view).length) return {error: 'Approve waits until the plan is within its hard limits'};
  if (verdict === 'edit') {
    if (view.gate.kind === 'plan') {
      const rows = pcEditRows(state);
      if (!rows.length) return {error: 'Choose another worker or reviewer for a task first'};
      body.edits = {rows};
    } else if (view.gate.kind === 'milestone') {
      const note = state.note.trim();
      if (!note) return {error: 'Write what to correct first'};
      if (state.note.length > PC_NOTE_MAX) return {error: 'The correction is longer than ' + PC_NOTE_MAX + ' characters'};
      body.edits = {note: state.note};
    } else {
      return {error: 'Say in the chat what to change in the brief'};
    }
  }
  return {body};
}

/**
 * What the window does with main's answer (AgentClient.projectDecision):
 * `view` to draw (the decision's, or the current one a refusal carries),
 * `continueMessage` to send, `error` / `notice` for the card.
 */
function pcOutcome(res) {
  if (!res || res.supported === false) return {error: 'This agent cannot take project decisions; update it.'};
  if (res.ok) return {view: res.view || null, continueMessage: typeof res.continueMessage === 'string' && res.continueMessage.trim() ? res.continueMessage : null};
  const view = res.view || null;
  switch (res.code) {
    case 'stale-version':
    case 'wrong-gate':
      return {view, notice: 'The project changed before your answer landed. Read this version and decide again.'};
    case 'turn-running':
      return {view, error: 'A turn is running in this chat. Decide once it has finished.'};
    case 'over-cap':
    case 'needs-estimates':
      return {view, error: res.error || 'The plan breaks a hard limit'};
    default:
      if (res.status === 404) return {closed: true, notice: 'This chat has no project any more.'};
      return {view, error: res.error || 'The decision did not go through'};
  }
}

function pcHardViolations(view) {
  return pcList(view && view.violations).filter((v) => v && v.severity === 'hard');
}

/* ---------- what the card shows ---------- */

function pcHeadline(view) {
  switch (view.gate.kind) {
    case 'brief': return 'The project brief waits for your approval';
    case 'plan': return 'The project plan waits for your approval';
    case 'milestone': {
      const m = pcList(view.milestones).find((x) => x.id === view.gate.id);
      return 'Milestone “' + pcStr(m && m.title || view.gate.id) + '” ' + (m && m.state === 'failed' ? 'failed' : 'is done') + ' and waits for your review';
    }
    default: return 'Nothing in the project waits for you';
  }
}

/** The buttons, in the order the agent allows them; labels as the TUI's card. */
function pcActions(view, state) {
  const hard = pcHardViolations(view).length > 0;
  return pcList(view.allowedVerdicts).map((verdict) => {
    switch (verdict) {
      case 'approve': return {verdict, label: view.gate.kind === 'milestone' ? 'Approve milestone' : 'Approve', primary: true,
        disabled: hard || state.busy, why: hard ? 'Over a hard limit: change the plan first' : ''};
      case 'edit':
        return view.gate.kind === 'milestone' ? {verdict, label: 'Correct…', open: 'correct', disabled: state.busy}
          : view.gate.kind === 'brief' ? {verdict, label: 'Revise in chat', revise: true, disabled: state.busy}
          : {verdict, label: 'Edit rows…', open: 'edit', disabled: state.busy};
      case 'cheaper': return {verdict, label: 'Cheaper', disabled: state.busy};
      case 'quality': return {verdict, label: 'Better quality', disabled: state.busy};
      case 'cancel': return {verdict, label: 'Cancel project', danger: true, disabled: state.busy};
      default: return null;
    }
  }).filter(Boolean);
}

/** Everything the card draws, as plain data (no DOM). */
function pcModel(state) {
  const view = state.view;
  if (!pcOpen(view)) return null;
  const gate = view.gate.kind;
  const brief = view.brief && typeof view.brief === 'object' ? view.brief : null;
  const warnings = [];
  if (brief && brief.draftedAfterUntrusted) warnings.push(PC_BRIEF_UNTRUSTED);
  if (gate !== 'brief' && view.plan && view.plan.draftedAfterUntrusted) warnings.push(PC_PLAN_UNTRUSTED);
  const briefLines = [];
  if (brief) {
    briefLines.push({label: 'What', text: pcStr(brief.what)});
    if (gate === 'brief') {
      briefLines.push({label: 'For', text: pcStr(brief.users)}, {label: 'How', text: pcStr(brief.how)});
      const g = brief.game;
      if (g && typeof g === 'object') briefLines.push({label: 'Game', text: [g.rules, g.loop, g.difficulty, g.style].map(pcStr).filter(Boolean).join(' · ')});
    }
  }
  const criteria = brief ? pcList(brief.successCriteria).map(pcStr).filter(Boolean) : [];
  const rows = gate === 'brief' ? [] : pcRows(view).map((r) => {
    const pick = pcPick(state, r.taskId) || {worker: r.worker, reviewer: r.reviewer};
    return {
      taskId: pcStr(r.taskId), title: pcStr(r.title), milestoneId: pcStr(r.milestoneId),
      worker: pcStr(pick.worker), reviewer: pick.reviewer === null || pick.reviewer === undefined ? null : pcStr(pick.reviewer),
      changed: !!state.picks[r.taskId],
      reason: pcStr(r.reason),
      basis: r.basis === 'measured' ? 'measured (' + (pcNum(r.samples) || 0) + ' run' + (r.samples === 1 ? '' : 's') + ')' : 'preset',
      estimate: pcUsd(pcNum(r.estCostUsd)) + ' · ' + pcDuration(pcNum(r.estMs)),
      workers: pcWorkerOptions(r), reviewers: pcReviewerOptions(r),
    };
  });
  let totals = null;
  if (rows.length && view.plan && view.plan.totals) {
    const t = view.plan.totals;
    const unpriced = pcNum(t.unknownCostRows) ? ' (+' + t.unknownCostRows + ' unpriced)' : '';
    totals = rows.length + ' task' + (rows.length === 1 ? '' : 's') + ' · ' + pcUsd(pcNum(t.costUsd)) + unpriced + ' · ' + pcDuration(pcNum(t.ms));
  }
  const gateId = gate === 'milestone' ? view.gate.id : null;
  const milestones = gate === 'brief' ? [] : pcList(view.milestones).map((m) => ({
    id: pcStr(m.id), title: pcStr(m.title), state: pcStr(m.state), mark: PC_MARK[m.state] || '·',
    current: m.id === gateId,
    estimate: pcNum(m.estCostUsd) === null && pcNum(m.estMs) === null ? '' : pcUsd(pcNum(m.estCostUsd)) + ' · ' + pcDuration(pcNum(m.estMs)),
  }));
  const current = gateId ? pcList(view.milestones).find((m) => m.id === gateId) : null;
  return {
    gate, version: view.version, headline: pcHeadline(view),
    warnings, brief: briefLines, criteria, rows, totals,
    scopeNote: gate === 'plan' && rows.length ? PC_WRITE_SCOPE_NOTE : null,
    violations: pcList(view.violations).map((v) => ({hard: v.severity === 'hard', text: pcStr(v.message)})),
    milestones,
    summary: current && current.summary ? pcStr(current.summary) : null,
    corrections: current ? pcList(current.corrections).map((c) => pcStr(c && c.note)).filter(Boolean) : [],
    actions: pcActions(view, state),
    mode: state.mode, note: state.note, noteMax: PC_NOTE_MAX,
    busy: state.busy, error: state.error, notice: state.notice,
    changedRows: pcEditRows(state).length,
  };
}

/* ---------- DOM (textContent only) ---------- */

function pcEl(doc, tag, cls, text) {
  const el = doc.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

function pcButton(doc, label, cls, onClick, disabled, title) {
  const b = pcEl(doc, 'button', cls, label);
  b.type = 'button';
  if (disabled) b.disabled = true;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function pcSelect(doc, options, value, label, onChange, disabled) {
  const sel = pcEl(doc, 'select', 'pc-select');
  sel.setAttribute('aria-label', label);
  options.forEach((opt, i) => {
    const o = pcEl(doc, 'option', null, opt === null ? 'no review' : opt);
    o.value = String(i);
    if (opt === value) o.selected = true;
    sel.appendChild(o);
  });
  if (disabled) sel.disabled = true;
  sel.addEventListener('change', () => onChange(options[Number(sel.value)]));
  return sel;
}

/**
 * The card for `model` into `host` (emptied first). `on` gets the person's
 * acts: {type: 'verdict', verdict} | {type: 'edit'|'correct'|'back'|'hide'|'revise'}
 * | {type: 'worker'|'reviewer', taskId, value} | {type: 'note', note}.
 */
function pcDraw(doc, host, model, on) {
  while (host.firstChild) host.removeChild(host.firstChild);
  if (!model) { host.hidden = true; return; }
  host.hidden = false;
  const card = pcEl(doc, 'section', 'pc-card');
  card.setAttribute('aria-label', 'Project');
  const head = pcEl(doc, 'div', 'pc-head');
  head.appendChild(pcEl(doc, 'div', 'pc-title', model.headline));
  head.appendChild(pcEl(doc, 'span', 'pc-ver', 'v' + model.version));
  head.appendChild(pcButton(doc, 'Hide', 'btn btn-g xs', () => on({type: 'hide'}), false, 'Put the card away; reopening the chat shows it again'));
  card.appendChild(head);
  for (const w of model.warnings) card.appendChild(pcEl(doc, 'p', 'pc-warn', w));
  if (model.brief.length || model.criteria.length) {
    const b = pcEl(doc, 'dl', 'pc-brief');
    for (const line of model.brief) {
      b.appendChild(pcEl(doc, 'dt', null, line.label));
      b.appendChild(pcEl(doc, 'dd', null, line.text));
    }
    if (model.criteria.length) {
      b.appendChild(pcEl(doc, 'dt', null, 'Done when'));
      const dd = pcEl(doc, 'dd');
      const ul = pcEl(doc, 'ul', 'pc-criteria');
      for (const c of model.criteria) ul.appendChild(pcEl(doc, 'li', null, c));
      dd.appendChild(ul);
      b.appendChild(dd);
    }
    card.appendChild(b);
  }
  if (model.rows.length) {
    const list = pcEl(doc, 'ol', 'pc-rows');
    for (const r of model.rows) {
      const li = pcEl(doc, 'li', 'pc-row' + (r.changed ? ' is-changed' : ''));
      const top = pcEl(doc, 'div', 'pc-row-top');
      top.appendChild(pcEl(doc, 'span', 'pc-task', r.taskId));
      top.appendChild(pcEl(doc, 'span', 'pc-row-title', r.title));
      if (r.milestoneId) top.appendChild(pcEl(doc, 'span', 'pc-ms', r.milestoneId));
      li.appendChild(top);
      const who = pcEl(doc, 'div', 'pc-who');
      if (model.mode === 'edit') {
        who.appendChild(pcEl(doc, 'span', 'pc-lbl', 'worker'));
        who.appendChild(pcSelect(doc, r.workers, r.worker, 'Worker for ' + r.taskId, (value) => on({type: 'worker', taskId: r.taskId, value}), model.busy));
        who.appendChild(pcEl(doc, 'span', 'pc-lbl', 'review'));
        who.appendChild(pcSelect(doc, r.reviewers, r.reviewer, 'Reviewer for ' + r.taskId, (value) => on({type: 'reviewer', taskId: r.taskId, value}), model.busy));
      } else {
        who.appendChild(pcEl(doc, 'span', null, 'worker ' + r.worker + ' · review ' + (r.reviewer === null ? 'none' : r.reviewer)));
      }
      li.appendChild(who);
      li.appendChild(pcEl(doc, 'div', 'pc-meta', r.estimate + ' · ' + r.basis));
      if (r.reason) li.appendChild(pcEl(doc, 'div', 'pc-reason', r.reason));
      list.appendChild(li);
    }
    card.appendChild(list);
  }
  if (model.totals) card.appendChild(pcEl(doc, 'div', 'pc-total', 'Total: ' + model.totals));
  if (model.scopeNote) card.appendChild(pcEl(doc, 'p', 'pc-scope', model.scopeNote));
  if (model.violations.length) {
    const ul = pcEl(doc, 'ul', 'pc-violations');
    for (const v of model.violations) ul.appendChild(pcEl(doc, 'li', v.hard ? 'pc-hard' : 'pc-soft', (v.hard ? '✕ Over a hard limit: ' : '! ') + v.text));
    card.appendChild(ul);
  }
  if (model.milestones.length) {
    const ul = pcEl(doc, 'ul', 'pc-milestones');
    for (const m of model.milestones) {
      const li = pcEl(doc, 'li', 'pc-milestone is-' + m.state.replace(/[^a-z_]/g, '') + (m.current ? ' is-current' : ''),
        m.mark + ' ' + m.title + ' — ' + m.state.replace('_', ' ') + (m.estimate ? ' · ' + m.estimate : ''));
      ul.appendChild(li);
    }
    card.appendChild(ul);
  }
  if (model.summary) card.appendChild(pcEl(doc, 'p', 'pc-summary', model.summary));
  for (const c of model.corrections) card.appendChild(pcEl(doc, 'p', 'pc-correction', 'Earlier correction: ' + c));
  if (model.notice) card.appendChild(pcEl(doc, 'p', 'pc-notice', model.notice));
  if (model.error) card.appendChild(pcEl(doc, 'p', 'pc-error', model.error));
  const bar = pcEl(doc, 'div', 'pc-actions');
  if (model.mode === 'correct') {
    const ta = pcEl(doc, 'textarea', 'pc-note');
    ta.maxLength = model.noteMax;
    ta.placeholder = 'What should the milestone do differently?';
    ta.setAttribute('aria-label', 'Your correction');
    ta.value = model.note;
    if (model.busy) ta.disabled = true;
    const count = pcEl(doc, 'div', 'pc-count', model.note.length + ' / ' + model.noteMax);
    // The text stays in its own box between paints; only the counter follows it.
    ta.addEventListener('input', () => { count.textContent = ta.value.length + ' / ' + model.noteMax; on({type: 'note', note: ta.value}); });
    card.appendChild(ta);
    card.appendChild(count);
    bar.appendChild(pcButton(doc, 'Send correction', 'btn btn-p sm', () => on({type: 'verdict', verdict: 'edit'}), model.busy));
    bar.appendChild(pcButton(doc, 'Back', 'btn btn-g sm', () => on({type: 'back'}), model.busy));
  } else if (model.mode === 'edit') {
    bar.appendChild(pcButton(doc, model.changedRows ? 'Re-estimate ' + model.changedRows + ' change' + (model.changedRows === 1 ? '' : 's') : 'Re-estimate',
      'btn btn-p sm', () => on({type: 'verdict', verdict: 'edit'}), model.busy || !model.changedRows));
    bar.appendChild(pcButton(doc, 'Back', 'btn btn-g sm', () => on({type: 'back'}), model.busy));
  } else {
    for (const a of model.actions) {
      const cls = 'btn sm ' + (a.primary ? 'btn-p' : a.danger ? 'btn-g pc-danger' : 'btn-s');
      const act = a.open ? {type: a.open} : a.revise ? {type: 'revise'} : {type: 'verdict', verdict: a.verdict};
      bar.appendChild(pcButton(doc, a.label, cls, () => on(act), a.disabled, a.why));
    }
  }
  if (model.busy) bar.appendChild(pcEl(doc, 'span', 'pc-busy', 'Sending…'));
  card.appendChild(bar);
  host.appendChild(card);
}

/* ---------- the controller: one card for the chat on screen ---------- */

/**
 * `api.read(sid)` → AgentClient.getProject's answer; `api.decide(body)` →
 * projectDecision's. `onContinue(sid, text)` sends the next message and
 * answers whether it went (false: kept until that chat is on screen).
 * `onRevise()` puts the caret in the composer. `draw(model)` paints.
 */
function createProjectCard(opts) {
  const store = pcStore();
  const pending = new Map();   // sid → continue message not sent yet
  const hidden = new Set();    // sid:version the person put away
  let sid = null, state = pcInitial(null), serial = 0;
  const key = () => sid + ':' + (state.view ? state.view.version : '');
  function paint() {
    const model = sid && !hidden.has(key()) ? pcModel(state) : null;
    opts.draw(model, act);
  }
  function setView(view, notice) {
    state = pcReduce(state, {type: 'view', view, notice});
  }
  function act(a) {
    switch (a.type) {
      case 'verdict': return decide(a.verdict);
      case 'worker': state = pcReduce(state, {type: 'worker', taskId: a.taskId, worker: a.value}); return paint();
      case 'reviewer': state = pcReduce(state, {type: 'reviewer', taskId: a.taskId, reviewer: a.value}); return paint();
      case 'note': state = pcReduce(state, {type: 'note', note: a.note}); return;   // the textarea keeps its own text
      case 'hide': hidden.add(key()); return paint();
      case 'revise': if (opts.onRevise) opts.onRevise(); state = pcReduce(state, {type: 'notice', notice: 'Say in the chat what to change; the director drafts the brief again.'}); return paint();
      default: state = pcReduce(state, {type: a.type}); return paint();
    }
  }
  async function decide(verdict) {
    if (state.busy) return;
    const here = sid;
    const built = pcDecision(state, here, verdict);
    if (built.error) { state = pcReduce(state, {type: 'failed', error: built.error}); return paint(); }
    state = pcReduce(state, {type: 'sending'}); paint();
    const res = await Promise.resolve().then(() => opts.api.decide(built.body)).catch((e) => ({supported: true, ok: false, status: 0, code: null, error: String(e)}));
    const out = pcOutcome(res);
    if (out.closed) store.drop(here);
    else if (out.view) store.put(here, out.view);
    if (out.continueMessage) pending.set(here, out.continueMessage);
    if (here === sid) {
      const view = store.get(here);
      setView(view, out.notice);
      if (out.error) state = pcReduce(state, {type: 'failed', error: out.error});
      else if (out.notice && view) state = pcReduce(state, {type: 'notice', notice: out.notice});
      else state.busy = false;
      paint();
    }
    flush();
  }
  function flush() {
    if (!sid || !pending.has(sid)) return;
    // Taken off before the send: the send paints, and a paint follows the chat again.
    const text = pending.get(sid), at = sid;
    pending.delete(at);
    if (opts.onContinue(at, text) === false && !pending.has(at)) pending.set(at, text);
  }
  return {
    /** A `{sessionId, view}` frame from main. */
    onFrame(frame) {
      if (!frame || typeof frame !== 'object') return;
      const changed = store.put(frame.sessionId, frame.view);
      if (changed && frame.sessionId === sid) { setView(store.get(sid)); paint(); }
    },
    /** The chat on screen is `next` (null: none, or not saved yet). Reads its view once per change. */
    follow(next) {
      next = next || null;
      if (next === sid) { flush(); return; }
      sid = next; serial++;
      state = pcInitial(sid ? store.get(sid) : null);
      paint();
      flush();
      if (!sid) return;
      const mine = serial, asked = sid;
      Promise.resolve().then(() => opts.api.read(asked)).then((res) => {
        if (mine !== serial || !res || res.supported === false || !res.ok) return;
        const changed = res.view ? store.put(asked, res.view) : store.drop(asked);
        if (changed) { setView(store.get(asked)); paint(); }
      }).catch(() => undefined);
    },
    /** Another agent is on the wire: what the last one said is not this one's. */
    reset() { const keep = sid; store.clear(); pending.clear(); hidden.clear(); sid = null; state = pcInitial(null); this.follow(keep); },
    state: () => state,
    store,
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    PC_NOTE_MAX, PC_WRITE_SCOPE_NOTE, PC_PLAN_UNTRUSTED, PC_BRIEF_UNTRUSTED,
    pcStore, pcInitial, pcReduce, pcDecision, pcOutcome, pcModel, pcDraw, pcEditRows,
    pcWorkerOptions, pcReviewerOptions, pcUsd, pcDuration, createProjectCard,
  };
}
