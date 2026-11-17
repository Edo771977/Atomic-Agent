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

   The card draws the last view the agent sent for a chat, and only the
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
/* How long "Confirm cancel" waits for the second press. */
const PC_CONFIRM_MS = 4000;

/* The core's own sentences (src/session/project-gate-text.ts); test/project-card.test.mjs keeps them equal. */
const PC_WRITE_SCOPE_NOTE = "Approving lets these tasks write in this chat's folder (the session's working directory); a write outside it still asks.";
const PC_PLAN_UNTRUSTED = "⚠ The plan was drafted after outside content entered the chat. Check its tasks and workers before approving: approving lets them run without asking again.";
const PC_BRIEF_UNTRUSTED = '⚠ The brief was drafted after outside content entered the chat. Read it before approving.';

const PC_MARK = {planned: '·', approved: '▸', in_progress: '◐', done: '✓', failed: '✕', reviewed: '✔'};
/* A criterion fact's mark (project-gate-text.ts FACT_MARK; the test keeps them equal). */
const PC_FACT_MARK = {passed: '✓', failed: '✕', unverified: '?'};

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

/* ---------- the last view per chat ---------- */

/**
 * One view per chat, in the order the agent's frames arrive. The view's
 * `version` is the current gate's own counter (the brief's at the brief, the
 * plan's at the plan and milestones; session-project.ts gateVersion), not a
 * project-wide clock, so views are never compared across versions: the last
 * one the agent sent is the state. A stale answer is the agent's to refuse
 * (409 stale-version on the decision).
 */
function pcStore() {
  const views = new Map();
  return {
    get: (sid) => views.get(sid) || null,
    /** A `{sessionId, view}` frame or read. Answers whether what the chat's card draws changed. */
    put(sid, view) {
      if (!sid || !view || typeof view !== 'object' || view.schema !== 1) return false;
      const prev = views.get(sid) || null;
      if (!pcOpen(view)) return views.delete(sid);
      if (prev && JSON.stringify(prev) === JSON.stringify(view)) return false;
      views.set(sid, view);
      return true;
    },
    drop(sid) { return views.delete(sid); },
    clear() { views.clear(); },
  };
}

/* ---------- state and reducer ---------- */

/** The card's state for one chat's view. `mode`: view | edit (plan rows) | correct (milestone note). */
function pcInitial(view) {
  return {view: view || null, mode: 'view', picks: {}, note: '', busy: false, error: null, notice: null, confirmCancel: false};
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
      // A view that arrives while my own decision is in flight is its result, not a change under me.
      if (action.inFlight) return Object.assign(pcInitial(next), {busy: true});
      const wasEditing = s.mode !== 'view' && (Object.keys(s.picks).length > 0 || s.note.trim());
      return Object.assign(pcInitial(next), {
        notice: action.notice || (wasEditing && next ? 'The Fusion project changed while you were editing (now version ' + next.version + '); your changes were set aside.' : null),
      });
    }
    case 'edit':
      if (!s.view || s.view.gate.kind !== 'plan' || !pcList(s.view.allowedVerdicts).includes('edit') || !pcPlanEditable(s.view)) return s;
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
    case 'armCancel':
      return Object.assign(s, {confirmCancel: true, error: null});
    case 'disarmCancel':
      return Object.assign(s, {confirmCancel: false});
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
  if (!pcOpen(view)) return {error: 'Nothing in the Fusion project waits for you'};
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
  if (!res || res.supported === false) return {error: 'This agent cannot take Fusion project decisions; update it.'};
  if (res.ok) return {view: res.view || null, continueMessage: typeof res.continueMessage === 'string' && res.continueMessage.trim() ? res.continueMessage : null};
  const view = res.view || null;
  switch (res.code) {
    case 'stale-version':
    case 'wrong-gate':
      return {view, notice: 'The Fusion project changed before your answer landed. Read this version and decide again.'};
    case 'turn-running':
      return {view, error: 'A turn is running in this chat. Decide once it has finished.'};
    case 'over-cap':
    case 'needs-estimates':
      return {view, error: res.error || 'The plan breaks a hard limit'};
    default:
      if (res.status === 404) return {closed: true, notice: 'This chat has no Fusion project any more.'};
      return {view, error: res.error || 'The decision did not go through'};
  }
}

function pcHardViolations(view) {
  return pcList(view && view.violations).filter((v) => v && v.severity === 'hard');
}

/* ---------- what the card shows ---------- */

/**
 * A milestone's picture as a line (issue #40): its caption with the criteria
 * it shows, as the core's attachmentLabel ("The board [c1, c2]"), then the
 * file's name. Text only: the card reads no file and draws no image or file
 * link; showing the picture needs a safe file read through main (a follow-up).
 */
function pcPictureLine(a) {
  const ids = pcList(a.criteria).map(pcStr).filter(Boolean);
  const name = pcStr(a.path).split(/[\\/]/).pop();
  return pcStr(a.caption) + (ids.length ? ' [' + ids.join(', ') + ']' : '') + (name ? ' · ' + name : '');
}

/**
 * One criterion fact as a line, as the core's criterionFactLine words it
 * (issue #40): "✓ c1 passed: Runs offline", "? c2 unverified: Looks right
 * (no vision-capable reviewer)". The text is the brief's when it names the id.
 */
function pcFactLine(fact, criteria) {
  const id = pcStr(fact && fact.id), state = pcStr(fact && fact.state);
  const c = pcList(criteria).find((x) => x && x.id === id);
  const text = c ? pcStr(c.text) : '';
  const why = pcStr(fact && fact.why);
  return (PC_FACT_MARK[state] || '?') + ' ' + id + ' ' + state + (c ? ': ' + text : '') + (why ? ' (' + why + ')' : '');
}

function pcHeadline(view) {
  switch (view.gate.kind) {
    case 'brief': return 'The Fusion project brief waits for your approval';
    case 'plan': return 'The Fusion project plan waits for your approval';
    case 'milestone': {
      const m = pcList(view.milestones).find((x) => x.id === view.gate.id);
      return 'Milestone “' + pcStr(m && m.title || view.gate.id) + '” ' + (m && m.state === 'failed' ? 'failed' : 'is done') + ' and waits for your review';
    }
    default: return 'Nothing in the Fusion project waits for you';
  }
}

/**
 * Whether the plan's "Edit rows" offers a choice (issue #54): the view says
 * false when no row has another worker or a reviewer to pick. An older agent
 * sends no `editable`; that reads as true.
 */
function pcPlanEditable(view) {
  return !(view && view.plan && view.plan.editable === false);
}

/** The buttons, in the order the agent allows them; labels as the TUI's card. */
function pcActions(view, state) {
  const hard = pcHardViolations(view).length > 0;
  // Edit rows with nothing to choose is hidden, as in the TUI (the view's hint says why); `edit` stays allowed.
  const verdicts = pcList(view.allowedVerdicts).filter((v) => !(v === 'edit' && view.gate.kind === 'plan' && !pcPlanEditable(view)));
  return verdicts.map((verdict) => {
    switch (verdict) {
      case 'approve': return {verdict, label: view.gate.kind === 'milestone' ? 'Approve milestone' : 'Approve', primary: true,
        disabled: hard || state.busy, why: hard ? 'Over a hard limit: change the plan first' : ''};
      case 'edit':
        return view.gate.kind === 'milestone' ? {verdict, label: 'Correct…', open: 'correct', disabled: state.busy}
          : view.gate.kind === 'brief' ? {verdict, label: 'Revise in chat', revise: true, disabled: state.busy}
          : {verdict, label: 'Edit rows…', open: 'edit', disabled: state.busy};
      case 'cheaper': return {verdict, label: 'Cheaper', disabled: state.busy};
      case 'quality': return {verdict, label: 'Better quality', disabled: state.busy};
      case 'cancel': return state.confirmCancel
        ? {verdict, label: 'Confirm cancel', danger: true, disabled: state.busy, why: 'Press again to cancel the Fusion project; it stops asking in a few seconds'}
        : {verdict, label: 'Cancel Fusion project', danger: true, disabled: state.busy};
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
      // A local member's row is $0 by its own mark (issue #54), worded as the TUI card.
      estimate: (r.local === true ? '$0.00 (local)' : pcUsd(pcNum(r.estCostUsd))) + ' · ' + pcDuration(pcNum(r.estMs)),
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
    // Evidence of the result (issue #40), the runtime's facts only: never a claim the view does not carry.
    facts: pcList(m.criteriaFacts).filter((f) => f && typeof f === 'object')
      .map((f) => ({state: PC_FACT_MARK[f.state] ? f.state : 'unverified', text: pcFactLine(f, brief && brief.criteria)})),
    pictures: pcList(m.attachments).filter((a) => a && typeof a === 'object').map(pcPictureLine),
  }));
  const current = gateId ? pcList(view.milestones).find((m) => m.id === gateId) : null;
  return {
    gate, version: view.version, headline: pcHeadline(view),
    warnings, brief: briefLines, criteria, rows, totals,
    scopeNote: gate === 'plan' && rows.length ? PC_WRITE_SCOPE_NOTE : null,
    violations: pcList(view.violations).map((v) => ({hard: v.severity === 'hard', text: pcStr(v.message)})),
    hints: pcList(view.hints).map(pcStr).filter(Boolean),
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

/** Marks a control by what it does, so a repaint can put the focus back on its successor. */
function pcFocusKey(el, key) { el.setAttribute('data-pc-focus', key); return el; }

function pcButton(doc, label, cls, onClick, disabled, title) {
  const b = pcEl(doc, 'button', cls, label);
  b.type = 'button';
  if (disabled) b.disabled = true;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

/**
 * A team member ref (`provider:model`): the provider and the model each stay
 * whole and a line may break only after the colon; the full ref is the title.
 */
function pcRef(doc, ref) {
  const el = pcEl(doc, 'span', 'pc-ref');
  el.title = ref;
  const at = ref.indexOf(':');
  if (at <= 0) { el.appendChild(pcEl(doc, 'span', 'pc-ref-part', ref)); return el; }
  el.appendChild(pcEl(doc, 'span', 'pc-ref-part', ref.slice(0, at + 1)));
  el.appendChild(doc.createElement('wbr'));
  el.appendChild(pcEl(doc, 'span', 'pc-ref-part', ref.slice(at + 1)));
  return el;
}

/**
 * Where the card sits. Wide: a column of its own beside the chat (#main is a
 * flex row; the chat column narrows), nothing to measure. Narrow (the
 * `--narrow` class, below PC_NARROW_PX): a sheet over the message list,
 * between the chat's top and the composer's top, so it never covers the
 * composer. Called after each paint and on resize.
 */
const PC_NARROW_PX = 1000;
function pcPlace(win, host) {
  if (!host || host.hidden) return;
  const narrow = win.innerWidth < PC_NARROW_PX;
  host.classList.toggle('pc-narrow', narrow);
  if (!narrow) return;
  const doc = win.document;
  const content = doc.querySelector('#content');
  const composer = doc.querySelector('.composerwrap') || doc.querySelector('#composer');
  if (!content) return;
  const c = content.getBoundingClientRect();
  const bottom = composer ? composer.getBoundingClientRect().top : c.bottom;
  host.style.setProperty('--pc-left', Math.round(c.left + 8) + 'px');
  host.style.setProperty('--pc-width', Math.max(0, Math.round(c.width - 16)) + 'px');
  host.style.setProperty('--pc-top', Math.round(c.top + 8) + 'px');
  host.style.setProperty('--pc-height', Math.max(120, Math.round(bottom - c.top - 16)) + 'px');
}

/**
 * Keeps the narrow sheet placed as the composer grows (a second line, an
 * attachment) or the chat column changes, through a ResizeObserver on
 * #content and the composer. `sync()` is cheap (no layout read): it only
 * notices that a paint replaced the composer node and observes the new one.
 */
function pcWatch(win, host) {
  const RO = win.ResizeObserver;
  let observer = null, content = null, composer = null;
  const place = () => pcPlace(win, typeof host === 'function' ? host() : host);
  return {
    sync() {
      if (!RO) return;
      if (!observer) observer = new RO(place);
      const doc = win.document;
      const c = doc.querySelector('#content');
      const k = doc.querySelector('.composerwrap') || doc.querySelector('#composer');
      if (c !== content) { if (content) observer.unobserve(content); content = c; if (c) observer.observe(c); }
      if (k !== composer) { if (composer) observer.unobserve(composer); composer = k; if (k) observer.observe(k); }
    },
  };
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
  /* Accessibility: what had the focus is found again after the paint, by
     what it does; a correction box being typed in is kept as it is (the
     same node: its text and caret), never rebuilt under the person. */
  const active = doc.activeElement && host.contains && host.contains(doc.activeElement) ? doc.activeElement : null;
  const focusKey = active && active.getAttribute ? active.getAttribute('data-pc-focus') : null;
  const keepNote = focusKey === 'note' ? active : null;
  const caret = keepNote ? [keepNote.selectionStart, keepNote.selectionEnd] : null;
  while (host.firstChild) host.removeChild(host.firstChild);
  if (!model) { host.hidden = true; return; }
  host.hidden = false;
  const card = pcEl(doc, 'section', 'pc-card');
  card.setAttribute('aria-label', 'Fusion project');
  const head = pcEl(doc, 'div', 'pc-head');
  head.appendChild(pcEl(doc, 'div', 'pc-title', model.headline));
  head.appendChild(pcEl(doc, 'span', 'pc-ver', 'v' + model.version));
  head.appendChild(pcFocusKey(pcButton(doc, 'Hide', 'btn btn-g xs', () => on({type: 'hide'}), false, 'Put the card away; reopening the chat shows it again'), 'hide'));
  card.appendChild(head);
  /* Only the body scrolls: the head and the action bar stay in view. */
  const body = pcEl(doc, 'div', 'pc-body');
  card.appendChild(body);
  for (const w of model.warnings) body.appendChild(pcEl(doc, 'p', 'pc-warn', w));
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
    body.appendChild(b);
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
        who.appendChild(pcFocusKey(pcSelect(doc, r.workers, r.worker, 'Worker for ' + r.taskId, (value) => on({type: 'worker', taskId: r.taskId, value}), model.busy), 'worker:' + r.taskId));
        who.appendChild(pcEl(doc, 'span', 'pc-lbl', 'review'));
        who.appendChild(pcFocusKey(pcSelect(doc, r.reviewers, r.reviewer, 'Reviewer for ' + r.taskId, (value) => on({type: 'reviewer', taskId: r.taskId, value}), model.busy), 'reviewer:' + r.taskId));
      } else {
        // Each label stays with its ref; the pair wraps as one.
        const pair = (label, node) => { const p = pcEl(doc, 'span', 'pc-pair'); p.appendChild(pcEl(doc, 'span', 'pc-lbl', label)); p.appendChild(node); return p; };
        who.appendChild(pair('worker ', pcRef(doc, r.worker)));
        who.appendChild(pair(' · review ', r.reviewer === null ? pcEl(doc, 'span', 'pc-ref', 'none') : pcRef(doc, r.reviewer)));
      }
      li.appendChild(who);
      li.appendChild(pcEl(doc, 'div', 'pc-meta', r.estimate + ' · ' + r.basis));
      if (r.reason) li.appendChild(pcEl(doc, 'div', 'pc-reason', r.reason));
      list.appendChild(li);
    }
    body.appendChild(list);
  }
  if (model.totals) body.appendChild(pcEl(doc, 'div', 'pc-total', 'Total: ' + model.totals));
  if (model.scopeNote) body.appendChild(pcEl(doc, 'p', 'pc-scope', model.scopeNote));
  if (model.violations.length) {
    const ul = pcEl(doc, 'ul', 'pc-violations');
    for (const v of model.violations) ul.appendChild(pcEl(doc, 'li', v.hard ? 'pc-hard' : 'pc-soft', (v.hard ? '✕ Over a hard limit: ' : '! ') + v.text));
    body.appendChild(ul);
  }
  // One-line advice from the agent (issue #54), worded as the TUI card.
  for (const h of model.hints) body.appendChild(pcEl(doc, 'p', 'pc-hint', 'ℹ ' + h));
  if (model.milestones.length) {
    const ul = pcEl(doc, 'ul', 'pc-milestones');
    for (const m of model.milestones) {
      const li = pcEl(doc, 'li', 'pc-milestone is-' + m.state.replace(/[^a-z_]/g, '') + (m.current ? ' is-current' : ''),
        m.mark + ' ' + m.title + ' — ' + m.state.replace('_', ' ') + (m.estimate ? ' · ' + m.estimate : ''));
      if (m.facts.length) {
        const facts = pcEl(doc, 'ul', 'pc-facts');
        facts.setAttribute('aria-label', 'Success criteria');
        for (const f of m.facts) facts.appendChild(pcEl(doc, 'li', 'pc-fact is-' + f.state, f.text));
        li.appendChild(facts);
      }
      if (m.pictures.length) {
        const pics = pcEl(doc, 'ul', 'pc-pictures');
        pics.setAttribute('aria-label', 'Pictures of the result');
        pics.appendChild(pcEl(doc, 'li', 'pc-pictures-count', m.pictures.length + ' picture' + (m.pictures.length === 1 ? '' : 's')));
        for (const p of m.pictures) pics.appendChild(pcEl(doc, 'li', 'pc-picture', '▣ ' + p));
        li.appendChild(pics);
      }
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }
  if (model.summary) body.appendChild(pcEl(doc, 'p', 'pc-summary', model.summary));
  for (const c of model.corrections) body.appendChild(pcEl(doc, 'p', 'pc-correction', 'Earlier correction: ' + c));
  if (model.notice) {
    const n = body.appendChild(pcEl(doc, 'p', 'pc-notice', model.notice));
    n.setAttribute('role', 'status'); n.setAttribute('aria-live', 'polite');
  }
  if (model.error) body.appendChild(pcEl(doc, 'p', 'pc-error', model.error)).setAttribute('role', 'alert');
  const bar = pcEl(doc, 'div', 'pc-actions');
  if (model.mode === 'correct') {
    let ta = keepNote;
    if (!ta) {
      ta = pcFocusKey(pcEl(doc, 'textarea', 'pc-note'), 'note');
      ta.maxLength = model.noteMax;
      ta.placeholder = 'What should the milestone do differently?';
      ta.setAttribute('aria-label', 'Your correction');
      ta.value = model.note;
      // The text stays in its own box between paints; only the counter follows it.
      ta.addEventListener('input', () => { if (ta._pcCount) ta._pcCount.textContent = ta.value.length + ' / ' + model.noteMax; on({type: 'note', note: ta.value}); });
    }
    ta.disabled = !!model.busy;
    const count = pcEl(doc, 'div', 'pc-count', ta.value.length + ' / ' + model.noteMax);
    ta._pcCount = count;
    body.appendChild(ta);
    body.appendChild(count);
    bar.appendChild(pcFocusKey(pcButton(doc, 'Send correction', 'btn btn-p sm', () => on({type: 'verdict', verdict: 'edit'}), model.busy), 'send-correction'));
    bar.appendChild(pcFocusKey(pcButton(doc, 'Back', 'btn btn-g sm', () => on({type: 'back'}), model.busy), 'back'));
  } else if (model.mode === 'edit') {
    bar.appendChild(pcFocusKey(pcButton(doc, model.changedRows ? 'Re-estimate ' + model.changedRows + ' change' + (model.changedRows === 1 ? '' : 's') : 'Re-estimate',
      'btn btn-p sm', () => on({type: 'verdict', verdict: 'edit'}), model.busy || !model.changedRows), 're-estimate'));
    bar.appendChild(pcFocusKey(pcButton(doc, 'Back', 'btn btn-g sm', () => on({type: 'back'}), model.busy), 'back'));
  } else {
    for (const a of model.actions) {
      const cls = 'btn sm ' + (a.primary ? 'btn-p' : a.danger ? 'btn-g pc-danger' : 'btn-s');
      const act = a.open ? {type: a.open} : a.revise ? {type: 'revise'} : {type: 'verdict', verdict: a.verdict};
      bar.appendChild(pcFocusKey(pcButton(doc, a.label, cls, () => on(act), a.disabled, a.why), 'verdict:' + a.verdict));
    }
  }
  if (model.busy) bar.appendChild(pcEl(doc, 'span', 'pc-busy', 'Sending…'));
  card.appendChild(bar);
  host.appendChild(card);
  if (keepNote) {
    keepNote.focus();
    if (caret && keepNote.setSelectionRange && caret[0] !== undefined) keepNote.setSelectionRange(caret[0], caret[1]);
  } else if (focusKey) {
    const next = pcFind(card, (e) => e.getAttribute && e.getAttribute('data-pc-focus') === focusKey);
    if (next) next.focus();
  }
}

/** The first element under `root` that `test` accepts (children only, so it works on any DOM). */
function pcFind(root, test) {
  for (const c of root.children || []) {
    if (test(c)) return c;
    const hit = pcFind(c, test);
    if (hit) return hit;
  }
  return null;
}

/**
 * Whether the window may send a continue message now. Everything that would
 * make submit() keep it out (or, for dictation, stop the recording instead
 * of sending) answers no, so the message stays pending rather than lost:
 * a model test holding the local server (`fitHolds`) among them, and any
 * room but the chat on screen (`room`: Studio draws into the same column),
 * the Settings window over the chat (`settings`; Cron jobs and Skills open there),
 * and a local route whose model is not on disk (`localBlocked`: the gate
 * would hand the message back to the editor), and a model switch
 * (`switching`: submit() would queue it, and a queued message can be dropped). What this
 * cannot foresee, submit() answers itself (false: not sent, still pending).
 */
function pcCanContinue(env) {
  return !!env && env.onScreen && env.room === 'chat' && !env.settings && !env.busy && !env.pending && env.connected && !env.opening
    && !['recording', 'starting', 'finishing'].includes(env.voice) && !env.starterHolds && !env.fitHolds && !env.gating
    && !env.localBlocked && !env.switching;
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
  const hidden = new Set();    // the gates the person put away in the chat on screen (sid, gate, version)
  const frames = new Map();    // sid → frames seen, so a read answered after a frame does not overwrite it
  let sid = null, state = pcInitial(null), serial = 0, cancelTimer = null;
  const key = () => {
    const v = state.view;
    return v ? JSON.stringify([sid, v.gate.kind, v.gate.id || '', v.version]) : '';
  };
  const changed = () => { if (opts.onChange) opts.onChange(); };
  const notify = changed;
  function paint() {
    const model = sid && !hidden.has(key()) ? pcModel(state) : null;
    opts.draw(model, act);
  }
  function setView(view, notice) {
    state = pcReduce(state, {type: 'view', view, notice});
  }
  function act(a) {
    switch (a.type) {
      case 'verdict':
        // Cancel ends the project: the first press only arms it, for a few seconds.
        if (a.verdict === 'cancel' && !state.confirmCancel) {
          state = pcReduce(state, {type: 'armCancel'});
          const armedFor = key();
          clearTimeout(cancelTimer);
          cancelTimer = setTimeout(() => { if (key() === armedFor && state.confirmCancel) { state = pcReduce(state, {type: 'disarmCancel'}); paint(); } }, opts.confirmMs ?? PC_CONFIRM_MS);
          return paint();
        }
        clearTimeout(cancelTimer);
        return decide(a.verdict);
      case 'worker': state = pcReduce(state, {type: 'worker', taskId: a.taskId, worker: a.value}); return paint();
      case 'reviewer': state = pcReduce(state, {type: 'reviewer', taskId: a.taskId, reviewer: a.value}); return paint();
      case 'note': state = pcReduce(state, {type: 'note', note: a.note}); return;   // the textarea keeps its own text
      case 'hide': hidden.add(key()); paint(); return changed();
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
      frames.set(frame.sessionId, (frames.get(frame.sessionId) || 0) + 1);
      const changed = store.put(frame.sessionId, frame.view);
      if (changed && frame.sessionId === sid) {
        state = pcReduce(state, {type: 'view', view: store.get(sid), inFlight: state.busy});
        paint(); notify();
      }
    },
    /** The chat on screen is `next` (null: none, or not saved yet). Reads its view once per change. */
    follow(next) {
      next = next || null;
      if (next === sid) { flush(); return; }
      // Hide lasts while the chat stays on screen: opening it again shows its card.
      hidden.clear();
      sid = next; serial++;
      state = pcInitial(sid ? store.get(sid) : null);
      paint();
      notify();
      flush();
      if (!sid) return;
      const mine = serial, asked = sid, seen = frames.get(asked) || 0;
      Promise.resolve().then(() => opts.api.read(asked)).then((res) => {
        if (mine !== serial || !res || res.supported === false || !res.ok) return;
        if ((frames.get(asked) || 0) !== seen) return;   // a frame came after the read went out: it is newer
        const changed = res.view ? store.put(asked, res.view) : store.drop(asked);
        if (changed) { state = pcReduce(state, {type: 'view', view: store.get(asked), inFlight: state.busy}); paint(); notify(); }
      }).catch(() => undefined);
    },
    /* Another agent is on the wire (a restart, a remote one): what the last
       one said is not this one's, except a continue message still owed to a
       chat, which the person's decision already recorded. */
    reset() { const keep = sid; store.clear(); hidden.clear(); sid = null; state = pcInitial(null); this.follow(keep); },
    /** Whether the chat on screen has an open gate the person hid (the header offers Show Fusion project). */
    hiddenOpen() { return !!sid && pcOpen(state.view) && hidden.has(key()); },
    /** Show Fusion project: the hidden card again. */
    show() { if (hidden.delete(key())) { paint(); changed(); } },
    state: () => state,
    store,
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    PC_NOTE_MAX, PC_WRITE_SCOPE_NOTE, PC_FACT_MARK, PC_PLAN_UNTRUSTED, PC_BRIEF_UNTRUSTED,
    pcStore, pcInitial, pcReduce, pcDecision, pcOutcome, pcModel, pcDraw, pcEditRows,
    pcWorkerOptions, pcReviewerOptions, pcUsd, pcDuration, createProjectCard, pcRef, pcPlace, PC_NARROW_PX, pcCanContinue, pcWatch,
  };
}
