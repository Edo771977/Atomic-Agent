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
/* Issue #146: a backlog call waits for the chat's turn (the agent would answer turn-running). */
const PC_WAIT_TURN = 'Decide once the turn finishes';
/* Issue #162: a backlog call refused as `stale-view` (the item changed since the card showed it). */
const PC_STALE_VIEW = 'This item changed \u2014 read it again';
/* How long "Confirm cancel" waits for the second press. */
const PC_CONFIRM_MS = 4000;

/* The core's own sentences (src/session/project-gate-text.ts); test/project-card.test.mjs keeps them equal. */
const PC_WRITE_SCOPE_NOTE = "Approving lets these tasks write in this chat's folder (the session's working directory); a write outside it still asks.";
const PC_PLAN_UNTRUSTED = "⚠ The plan was drafted after outside content entered the chat. Check its tasks and workers before approving: approving lets them run without asking again.";
const PC_BRIEF_UNTRUSTED = '⚠ The brief was drafted after outside content entered the chat. Read it before approving.';
/* Issue #109: the core's hint at a gate changed outside Atomic Agent (src/tools/fusion/project-gate-view.ts
   CHANGED_OUTSIDE_HINT; test/project-card-outside.test.mjs keeps it equal). The card says it as a
   warning naming the gate (pcChangedOutsideWarning) and drops the hint. */
const PC_CHANGED_OUTSIDE_HINT = "This changed outside Atomic Agent since your last decision (project.json was edited, or the project came from another machine): read it before approving.";
const PC_OUTSIDE_APPROVE_WHY = 'It changed outside Atomic Agent since your last decision: approving takes it as it is now';
/* Issue #109: a chat whose project could not be opened (GET /api/project's 404 `project_problem`). */
const PC_PROBLEM_HEADLINE = 'This chat’s Fusion project could not be opened';
const PC_PROBLEM_TODO = 'Fix or restore the Fusion project file (.atomic/project/project.json in the chat’s folder), or put the folder back, then open this chat again. Nothing is approved or run while it cannot be opened.';

const PC_MARK = {planned: '·', approved: '▸', in_progress: '◐', done: '✓', failed: '✕', reviewed: '✔'};
/* Issue #160: the kinds of non-code work read as words, as the TUI card's MILESTONE_KIND_LABEL
   (src/tui/project/project-card-lines.ts; test/project-card-evidence.test.mjs keeps them equal).
   Any other kind (base, ui, logic, polish, other) is shown as it is, as there. */
const PC_MILESTONE_KIND_LABEL = {draft: 'Draft', review: 'Review', final: 'Final'};
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

/**
 * Issue #146: no gate waits, but the backlog asks something of the person:
 * an item nobody decided (a seed waits for its condition), a call made stale outside Atomic Agent, or a
 * complete project that leaves items open or promoted ones never done.
 * The card then shows the backlog alone (between turns, as the TUI's b).
 */
function pcBacklogOnly(view) {
  if (!view || typeof view !== 'object' || view.cancelled || pcOpen(view)) return false;
  const b = view.backlog && typeof view.backlog === 'object' ? view.backlog : null;
  const exp = view.expectation || {};
  const closing = exp.kind === 'complete' && (pcNum(exp.promotedNotDone) > 0 || pcNum(exp.openBacklog) > 0);
  // A seed waits for its condition, so open seeds alone keep no card up (they show when it is up anyway).
  const undecided = (pcNum(b && b.open) || 0) - pcList(b && b.seeds).length;
  return !!b && (undecided > 0 || pcList(b.stale).length > 0 || closing);
}

/** What the chat's card draws: an open gate, or a backlog with something to decide. */
function pcShown(view) {
  return pcOpen(view) || pcBacklogOnly(view);
}

/**
 * Issue #146: a complete project's notes on its backlog, as the core words
 * them (project-store-views.ts, project-gate-view.ts): "complete with N
 * promoted backlog item(s) not done", with the items when its hint names them.
 */
function pcCompletion(view) {
  const exp = view && view.expectation;
  if (!exp || exp.kind !== 'complete') return [];
  const n = (k, word) => k + ' ' + word + (k === 1 ? '' : 's');
  const hints = pcList(view.hints).map(pcStr);
  const line = (head) => hints.find((h) => h === head || h.startsWith(head + ': ')) || head;
  const out = [];
  if (pcNum(exp.openBacklog) > 0) out.push(line('complete with ' + n(exp.openBacklog, 'backlog item') + ' open'));
  if (pcNum(exp.promotedNotDone) > 0) out.push(line('complete with ' + n(exp.promotedNotDone, 'promoted backlog item') + ' not done'));
  return out;
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
      if (!pcShown(view)) return views.delete(sid);
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
    case 'override':
      if (!s.view || !pcList(s.view.allowedVerdicts).includes('approveOverReview')) return s;
      return Object.assign(s, {mode: 'override', note: '', error: null, notice: null});
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
function pcDecision(state, sid, verdict, statusEdit) {
  const view = state.view;
  if (!pcOpen(view)) return {error: 'Nothing in the Fusion project waits for you'};
  if (!pcList(view.allowedVerdicts).includes(verdict)) return {error: 'This gate does not take that'};
  const body = {session: sid, gate: view.gate.kind === 'milestone' ? {kind: 'milestone', id: view.gate.id} : {kind: view.gate.kind}, version: view.version, verdict};
  if ((verdict === 'approve' || verdict === 'approveOverReview') && pcHardViolations(view).length) return {error: 'Approve waits until the plan is within its hard limits'};
  if (verdict === 'approveOverReview') {
    const note = state.note.trim();
    if (state.mode !== 'override' || !note) return {error: 'Write a reason for approving over review'};
    if (note.length > PC_NOTE_MAX) return {error: 'The reason is longer than ' + PC_NOTE_MAX + ' characters'};
    body.edits = {note};
  }
  if (verdict === 'edit' && statusEdit && statusEdit.backlog !== undefined) {
    const backlog = view.gate.kind === 'plan' && state.mode === 'view' ? pcBacklogModel(view, true, true) : null;
    const item = backlog && backlog.items.find((i) => i.id === statusEdit.backlog);
    if (!item || !item.statusActions.some(([, status]) => status === statusEdit.status)) return {error: 'This backlog status change is unavailable'};
    body.edits = {backlogStatus: {[item.id]: statusEdit.status}};
    return {body};
  }
  if (verdict === 'edit' && statusEdit && statusEdit.lesson !== undefined) {
    const lesson = pcList(view.lessonCoverage).find((item) => item && item.id === statusEdit.lesson);
    if (view.gate.kind !== 'plan' || state.mode !== 'view' || view.version !== statusEdit.version ||
        !lesson || pcLessonStatusAction(lesson)?.[1] !== statusEdit.status) {
      return {error: 'This lesson status change is unavailable'};
    }
    body.edits = {lessonStatus: {[lesson.id]: statusEdit.status}};
    return {body};
  }
  if (verdict === 'edit' && statusEdit) {
    const decision = pcList(view.decisions).find((d) => d && d.id === statusEdit.id);
    if (view.gate.kind !== 'plan' || state.mode !== 'view' || !decision ||
        !pcDecisionStatusActions(decision).some(([, status]) => status === statusEdit.status)) {
      return {error: 'This decision status change is unavailable'};
    }
    body.edits = {decisionStatus: {[decision.id]: statusEdit.status}};
    return {body};
  }
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

/** Issue #126: what a fact rests on, as the core's criterionBasisLabel (project-gate-text.ts). */
function pcBasisLabel(basis) {
  switch (basis && basis.kind) {
    case 'check': {
      const ui = pcList(basis.checks).filter((check) => check?.kind === 'ui').map((check) =>
        ['UI', check.impeccableVersion, check.mode === 'rendered' ? 'rendered page' : check.mode].filter(Boolean).join(' · '));
      return ui.length ? 'measured (' + [...new Set(ui)].join(', ') + ')' : 'measured';
    }
    case 'person': return 'declared by you';
    case 'vision': return 'judged by ' + pcStr(basis.model);
    default: return 'basis not recorded';
  }
}

/** A fact passed only on checks that may pass on the wrong thing (issue #110): never plain green. */
const pcReserved = (fact) => !!fact && fact.state === 'passed' && typeof fact.reservation === 'string';

/**
 * One criterion fact as a line, as the core's criterionFactLine words it
 * (issues #40, #110, #126): "✓ c1 passed: Runs offline · measured", "? c2
 * unverified: Looks right (no vision-capable reviewer) · basis not recorded",
 * "~ c3 passed with reservations: … (reservations: …) · measured". The text
 * is the brief's when it names the id.
 */
function pcFactLine(fact, criteria) {
  const id = pcStr(fact && fact.id), state = pcStr(fact && fact.state);
  const c = pcList(criteria).find((x) => x && x.id === id);
  const text = c ? pcStr(c.text) : '';
  const reserved = pcReserved(fact);
  const why = pcStr(fact && fact.why);
  const notes = (why ? [why] : []).concat(reserved ? ['reservations: ' + fact.reservation] : []);
  return (reserved ? '~' : PC_FACT_MARK[state] || '?') + ' ' + id + ' ' + (reserved ? 'passed with reservations' : state)
    + (c ? ': ' + text : '') + (notes.length ? ' (' + notes.join('; ') + ')' : '') + ' · ' + pcBasisLabel(fact && fact.basis);
}

/**
 * Issue #126: the facts counted by basis in one line, as the core's
 * criterionBasisSummaryLine: the view's `criteriaBasisSummary`, else
 * counted from the facts (summarizeCriterionBases), as the TUI card does.
 */
function pcBasisSummary(summary, facts) {
  const labelsByBasis = {check: 'measured', vision: 'judged by a model', person: 'declared by you', unrecorded: 'basis not recorded'};
  const bases = Object.keys(labelsByBasis);
  const counted = {check: 0, vision: 0, person: 0, unrecorded: 0};
  const reservations = {...counted};
  for (const fact of facts) {
    const kind = fact?.basis?.kind;
    const basis = bases.includes(kind) ? kind : 'unrecorded';
    counted[basis]++;
    if (pcReserved(fact)) reservations[basis]++;
  }
  const counts = summary && bases.every((basis) => pcNum(summary[basis]) !== null) ? summary : counted;
  const reservedByBasis = counts.withReservations ?? reservations;
  const total = bases.reduce((sum, basis) => sum + counts[basis], 0);
  const labels = [];
  for (const basis of bases) {
    const reserved = Math.max(0, Math.min(counts[basis], pcNum(reservedByBasis[basis]) ?? 0));
    const plain = counts[basis] - reserved;
    if (plain > 0) labels.push(plain + ' ' + labelsByBasis[basis]);
    if (reserved > 0) labels.push(reserved + ' ' + labelsByBasis[basis] + ' with reservations');
  }
  return total + ' ' + (total === 1 ? 'criterion' : 'criteria') + ': ' + labels.filter(Boolean).join(', ');
}

/** Issue #126: a director claim no passed fact supports, as the core's directorReportWarningLine. */
const pcClaimWarning = (sentence) => 'Warning: no matching passed criterion fact for director claim: ' + sentence;

/**
 * Issue #119: the `project verify` hint, as the TUI card's evidenceVerifyHint
 * (src/tui/project/project-card-lines.ts): the folder quoted, or as a JSON
 * string when it holds characters a shell or a terminal would read.
 */
function pcVerifyHint(folder) {
  const command = 'Run atomic-agent project verify';
  if (typeof folder !== 'string') return command;
  if (/[\x00-\x1f\x7f-\x9f"$%!`]/.test(folder) || folder.endsWith('\\')) {
    return command + ' for folder ' + JSON.stringify(folder).replace(/[\x7f-\x9f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  }
  return command + ' "' + folder + '"';
}

/**
 * Issue #119: a milestone's receipts (`evidenceReceipts`: valid, unsigned,
 * problems, partial, archiveUnavailable) as the TUI card's one "Evidence:"
 * line, its tone, and the verify hint when anything is not plainly signed;
 * null without receipts (an incognito chat writes none, an older agent sends none).
 */
function pcEvidence(receipts) {
  if (!receipts || typeof receipts !== 'object') return null;
  const valid = pcNum(receipts.valid) || 0, unsigned = pcNum(receipts.unsigned) || 0, problems = pcNum(receipts.problems) || 0;
  const partial = receipts.partial === true, unavailable = receipts.archiveUnavailable === true;
  if (pcNum(receipts.valid) === null && pcNum(receipts.unsigned) === null && pcNum(receipts.problems) === null && !partial && !unavailable) return null;
  const details = [];
  if (valid) details.push(valid + ' signed');
  if (unsigned) details.push(unsigned + ' unsigned (not verifiable; the signing key may have been unavailable)');
  if (problems) details.push(problems + ' problem' + (problems === 1 ? '' : 's'));
  if (partial) details.push('partial scan');
  if (unavailable) details.push('archive unavailable');
  const tone = problems || unavailable ? 'error' : unsigned || partial ? 'warn' : 'ok';
  return {line: 'Evidence: ' + details.join(', '), tone,
    hint: unsigned || problems || partial || unavailable ? pcVerifyHint(receipts.folder) : null};
}

/** The warning at a gate changed outside Atomic Agent, naming that gate. */
function pcChangedOutsideWarning(view) {
  const gate = view && view.gate ? view.gate : {kind: 'none'};
  let what = gate.kind;
  if (gate.kind === 'milestone') {
    const m = pcList(view.milestones).find((x) => x.id === gate.id);
    what = 'milestone “' + pcStr(m && m.title || gate.id) + '”';
  }
  return '⚠ The ' + what + ' changed outside Atomic Agent since your last decision (the Fusion project file was edited, or the Fusion project came from another machine): review it before approving.';
}

/** The card for a chat whose project could not be opened: the problem and what to do, no verdicts. */
function pcProblemModel(problem) {
  return {kind: 'problem', headline: PC_PROBLEM_HEADLINE, problem: pcStr(problem), todo: PC_PROBLEM_TODO};
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
        disabled: hard || state.busy, why: hard ? 'Over a hard limit: change the plan first' : view.changedOutside === true ? PC_OUTSIDE_APPROVE_WHY : ''};
      case 'edit':
        return view.gate.kind === 'milestone' ? {verdict, label: 'Correct…', open: 'correct', disabled: state.busy}
          : view.gate.kind === 'brief' ? {verdict, label: 'Revise in chat', revise: true, disabled: state.busy}
          : {verdict, label: 'Edit rows…', open: 'edit', disabled: state.busy};
      case 'approveOverReview': return {verdict, label: 'Approve over review…', open: 'override', disabled: hard || state.busy};
      case 'cheaper': return {verdict, label: 'Cheaper', disabled: state.busy};
      case 'quality': return {verdict, label: 'Better quality', disabled: state.busy};
      case 'cancel': return state.confirmCancel
        ? {verdict, label: 'Confirm cancel', danger: true, disabled: state.busy, why: 'Press again to cancel the Fusion project; it stops asking in a few seconds'}
        : {verdict, label: 'Cancel Fusion project', danger: true, disabled: state.busy};
      default: return null;
    }
  }).filter(Boolean);
}

function pcDecisionStatusActions(decision) {
  if (decision.status === 'active' && pcList(decision.citedBy).length === 0) return [['Defer', 'deferred'], ['Informational', 'informational']];
  if (decision.status === 'deferred') return [['Reactivate', 'active']];
  return [];
}

function pcLessonStatusAction(lesson) {
  if (!/^[a-z0-9-]{1,64}$/.test(lesson.id)) return null;
  return lesson.deferred === true ? ['Reactivate', 'active'] : ['Defer', 'deferred'];
}

function pcPlanCheck(hint) {
  const match = /^(check-lint|criteria-coverage|verifiability|decision-coverage|backlog-coverage|lesson-coverage|references): (pass|warn|fail): ([\s\S]*)$/.exec(hint);
  return match ? {dimension: match[1], verdict: match[2], detail: match[3], taskIds: []} : null;
}

function pcPlanReview(view) {
  const review = view.planReview;
  if (!review || typeof review !== 'object') return null;
  const results = pcList(review.results).filter((r) => r && typeof r.dimension === 'string' && ['pass', 'warn', 'fail'].includes(r.verdict));
  let warning = null;
  if (review.stale) warning = 'Notes on an earlier version';
  else if (['missing', 'skipped', 'not-run'].includes(review.outcome)) {
    warning = 'Plan not reviewed' + (review.reason ? ' — ' + pcStr(review.reason) : '');
  }
  const summary = [
    pcStr(review.reviewer),
    Number.isInteger(review.round) && review.round > 0 ? 'Round ' + review.round : '',
    review.autoApprovable === false ? 'Automatic approval paused' : '',
  ].filter(Boolean).join(' · ');
  return {results, warning, summary};
}

/* ---------- issue #146: the backlog ---------- */

/** How an item's source reads (project-backlog.ts backlogSourceLabel). */
function pcBacklogSource(item) {
  return item.fromPerson === true ? 'director (from your message)' : pcStr(item.source);
}

/**
 * The calls an item takes, as [label, state], like the TUI's backlog
 * (project-card-state.ts projectBacklogActions): every call but the
 * item's own (an open item is promoted or dropped, a promoted one dropped
 * or reopened, a dropped one promoted or reopened). A call made stale outside Atomic
 * Agent (the item reads open) can be made again or let go (`open` clears
 * it); a promoted item removed outside can only be cleared.
 */
function pcBacklogActions(item, stale) {
  if (stale && stale.reason === 'removed') return [['Clear', 'open']];
  if (stale) return [[stale.state === 'promoted' ? 'Promote again' : 'Promote', 'promoted'], [stale.state === 'dropped' ? 'Drop again' : 'Drop', 'dropped'], ['Keep open', 'open']];
  if (!item) return [];
  return [['Promote', 'promoted'], ['Drop', 'dropped'], ['Reopen', 'open']].filter(([, to]) => to !== item.state);
}

/** What a promoted item's call stands at, worded as `atomic-agent project backlog`. */
function pcBacklogStateText(item) {
  if (item.state === 'promoted') {
    if (Number.isInteger(item.plannedIn)) return 'promoted, taken in by plan v' + item.plannedIn;
    return item.deferred === true ? 'promoted, deferred at the plan gate, not in any plan' : 'promoted, not in any plan';
  }
  if (item.state === 'open' && pcStr(item.condition)) return 'seed · When: ' + pcStr(item.condition);
  return pcStr(item.state);
}

/** The core's hints the Backlog section says itself (project-gate-view.ts, project-gate-text.ts seedHint), so they are not drawn twice. */
function pcBacklogHints(backlog) {
  const out = new Set();
  for (const s of backlog.seeds) out.add('seed ' + s.id + ' "' + s.title + '" (when: ' + s.condition + '): yours to promote if it is met');
  for (const b of backlog.promoted) {
    out.add('promoted from the backlog: ' + b.id + ' "' + b.title + '": check this plan takes it in before approving');
    out.add('promoted from the backlog, deferred by you: ' + b.id + ' "' + b.title + '": this plan need not take it in; set it active again to require it');
  }
  for (const s of backlog.stale) {
    out.add(s.reason === 'removed' ? 'promoted item ' + s.id + ' was removed outside Atomic Agent'
      : 'backlog item ' + s.id + ' changed since you ' + s.state + ' it: it reads open again; ' + (s.state === 'promoted' ? 'promote' : 'drop') + ' it again if you still want it');
  }
  return out;
}

/** A promoted item's status edit at the plan gate, as [label, status]: the core's `edits.backlogStatus` (PERSON_BACKLOG_STATUSES). */
function pcBacklogStatusActions(promoted) {
  if (!/^[a-z0-9-]{1,32}$/.test(promoted.id)) return [];
  return promoted.deferred === true ? [['Reactivate', 'active']] : [['Defer', 'deferred']];
}

/**
 * The view's backlog as plain data, or null without one. Author text stays
 * text. At the plan gate (`plan`) a promoted item no approved plan took in
 * says which tasks cite it; `canEdit` adds its Defer / Reactivate.
 */
function pcBacklogModel(view, plan, canEdit) {
  const b = view && view.backlog;
  if (!b || typeof b !== 'object') return null;
  const backlog = {
    open: pcNum(b.open) || 0,
    seeds: pcList(b.seeds).filter((x) => x && typeof x.id === 'string').map((x) => ({id: x.id, title: pcStr(x.title), condition: pcStr(x.condition)})),
    promoted: pcList(b.promoted).filter((x) => x && typeof x.id === 'string'),
    stale: pcList(b.stale).filter((x) => x && typeof x.id === 'string' && (x.state === 'promoted' || x.state === 'dropped')),
    items: pcList(b.items).filter((x) => x && typeof x.id === 'string' && ['open', 'promoted', 'dropped'].includes(x.state)),
  };
  const staleOf = (id) => backlog.stale.find((x) => x.id === id) || null;
  const entry = (item, stale) => ({
    id: item ? item.id : stale.id,
    // Issue #162: what the person saw, sent back as expectedFingerprint (an older agent sends none).
    fingerprint: pcFingerprint(item && item.fingerprint) || pcFingerprint(stale && stale.fingerprint),
    title: item ? pcStr(item.title) : '',
    note: item ? pcStr(item.note) : '',
    state: item ? item.state : 'removed',
    meta: item ? [pcBacklogStateText(item), 'from ' + pcBacklogSource(item)].filter(Boolean).join(' · ') : '',
    stale: !stale ? null : stale.reason === 'removed'
      ? 'removed outside Atomic Agent since you ' + stale.state + ' it'
      : 'changed outside Atomic Agent since you ' + stale.state + ' it: it reads open again',
    actions: pcBacklogActions(item, stale),
    ...pcBacklogWaiting(item && plan ? backlog.promoted.find((x) => x.id === item.id) : null, canEdit),
  });
  const items = backlog.items.map((item) => entry(item, staleOf(item.id)))
    .concat(backlog.stale.filter((s) => s.reason === 'removed' && !backlog.items.some((i) => i.id === s.id)).map((s) => entry(null, s)));
  const summary = [backlog.open + ' open'].concat(backlog.seeds.length ? [backlog.seeds.length + ' seed' + (backlog.seeds.length === 1 ? '' : 's')] : [],
    backlog.promoted.length ? [backlog.promoted.length + ' promoted'] : []).join(' · ');
  return {summary, items, hints: pcBacklogHints(backlog)};
}

/** A view's decision fingerprint (backlogDecisionFingerprint: 64 lowercase hex), or null. */
function pcFingerprint(v) {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null;
}

/** A promoted item waiting for the plan: who cites it, and its status edit. */
function pcBacklogWaiting(promoted, canEdit) {
  // An agent before #146's coverage sends no citedBy and takes no backlogStatus edit (it would be an empty plan edit).
  if (!promoted || !Array.isArray(promoted.citedBy)) return {cited: null, statusActions: []};
  const by = pcList(promoted.citedBy).map(pcStr).filter(Boolean);
  return {cited: by.length ? 'Cited by: ' + by.join(', ') : 'No citing tasks', statusActions: canEdit ? pcBacklogStatusActions(promoted) : []};
}

/**
 * The backlog call `{sessionId, item, state, expectedFingerprint?}` for main
 * (agent:projectBacklog), or {error} when the view offers no such call.
 * Issue #162: the fingerprint binds the call to the item as the card showed it.
 */
function pcBacklogCall(state, sid, id, to) {
  const backlog = pcBacklogModel(state.view);
  const item = backlog && backlog.items.find((i) => i.id === id);
  if (!item || !item.actions.some(([, s]) => s === to)) return {error: 'This backlog call is unavailable'};
  return {body: {sessionId: sid, item: id, state: to, ...(item.fingerprint ? {expectedFingerprint: item.fingerprint} : {})}};
}

/** What the window does with main's answer to a backlog call: the view to draw, and a notice or an error. */
function pcBacklogOutcome(res, id, to) {
  if (!res || res.supported === false) return {error: 'This agent cannot take backlog calls; update it.'};
  if (res.ok) return {view: res.view || null, notice: id + (to === 'promoted' ? ' promoted for the next plan.' : to === 'dropped' ? ' dropped.' : ' is open again.')};
  const view = res.view || null;
  if (res.code === 'turn-running') return {view, error: 'A turn is running in this chat. Decide once it has finished.'};
  // Issue #162: the item or its call changed since the card drew it; the answer's view is drawn instead.
  if (res.code === 'stale-view') return {view, error: PC_STALE_VIEW};
  if (res.status === 404 && !view) return {closed: true, notice: 'This chat has no Fusion project any more.'};
  return {view, error: res.error || 'The backlog call did not go through'};
}

/** Issue #146: the card when no gate waits, the backlog alone (pcBacklogOnly). */
function pcBacklogOnlyModel(state) {
  const view = state.view;
  const backlog = pcBacklogModel(view, false, false);
  const complete = view.expectation && view.expectation.kind === 'complete';
  return {
    kind: 'backlog', gate: 'none', version: view.version,
    headline: complete ? 'The Fusion project is complete' : 'Fusion project backlog',
    completion: pcCompletion(view),
    backlog: backlog && {summary: backlog.summary, items: backlog.items},
    busy: state.busy, error: state.error, notice: state.notice,
  };
}

/**
 * Everything the card draws, as plain data (no DOM). `env.turnRunning`: a
 * turn runs in the chat, so a backlog call could only be refused
 * (`turn-running`): the backlog card stays away, and at a gate the
 * backlog's buttons wait for the turn.
 */
function pcModel(state, env) {
  const view = state.view;
  const turnRunning = !!(env && env.turnRunning);
  if (pcBacklogOnly(view)) return turnRunning ? null : pcBacklogOnlyModel(state);
  if (!pcOpen(view)) return null;
  const gate = view.gate.kind;
  const brief = view.brief && typeof view.brief === 'object' ? view.brief : null;
  const warnings = [];
  const changedOutside = view.changedOutside === true;
  if (changedOutside) warnings.push(pcChangedOutsideWarning(view));
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
  const milestones = gate === 'brief' ? [] : pcList(view.milestones).map((m) => ({ m, facts: pcList(m.criteriaFacts).filter((f) => f && typeof f === 'object') })).map(({m, facts}) => ({
    id: pcStr(m.id), title: pcStr(m.title), state: pcStr(m.state), mark: PC_MARK[m.state] || '·',
    kind: Object.prototype.hasOwnProperty.call(PC_MILESTONE_KIND_LABEL, m.kind) ? PC_MILESTONE_KIND_LABEL[m.kind] : pcStr(m.kind),
    current: m.id === gateId,
    estimate: pcNum(m.estCostUsd) === null && pcNum(m.estMs) === null ? '' : pcUsd(pcNum(m.estCostUsd)) + ' · ' + pcDuration(pcNum(m.estMs)),
    // Evidence of the result (issue #40), the runtime's facts only: never a claim the view does not carry.
    facts: facts.map((f) => ({state: pcReserved(f) ? 'reserved' : PC_FACT_MARK[f.state] ? f.state : 'unverified', text: pcFactLine(f, brief && brief.criteria)})),
    // Issue #126: how the facts were established, counted by basis.
    basis: facts.length ? pcBasisSummary(m.criteriaBasisSummary, facts) : null,
    pictures: pcList(m.attachments).filter((a) => a && typeof a === 'object').map(pcPictureLine),
    evidence: pcEvidence(m.evidenceReceipts),
  }));
  const current = gateId ? pcList(view.milestones).find((m) => m.id === gateId) : null;
  const canEditStatus = gate === 'plan' && state.mode === 'view' && pcList(view.allowedVerdicts).includes('edit');
  const backlog = pcBacklogModel(view, gate === 'plan', canEditStatus);
  const hints = pcList(view.hints).map(pcStr).filter((h) => h && !(changedOutside && h === PC_CHANGED_OUTSIDE_HINT) && !(backlog && backlog.hints.has(h)));
  const checks = gate === 'plan' ? hints.map(pcPlanCheck).filter(Boolean) : [];
  const review = gate === 'plan' ? pcPlanReview(view) : null;
  const decisions = pcList(view.decisions).filter((d) => d && typeof d.id === 'string').map((d) => ({
    id: d.id, text: pcStr(d.text), status: pcStr(d.status), citedBy: pcList(d.citedBy).map(pcStr).filter(Boolean),
    actions: canEditStatus ? pcDecisionStatusActions(d) : [],
  }));
  const lessons = gate === 'plan' ? pcList(view.lessonCoverage).filter((lesson) => lesson && typeof lesson.id === 'string').map((lesson) => ({
    id: lesson.id, title: pcStr(lesson.title), deferred: lesson.deferred === true,
    citedBy: pcList(lesson.citedBy).map(pcStr).filter(Boolean),
    missingFrom: pcList(lesson.missingFrom).map(pcStr).filter(Boolean),
    action: canEditStatus ? pcLessonStatusAction(lesson) : null,
  })) : [];
  return {
    kind: 'gate', changedOutside,
    gate, version: view.version, headline: pcHeadline(view),
    warnings, brief: briefLines, criteria, rows, totals,
    scopeNote: gate === 'plan' && rows.length ? PC_WRITE_SCOPE_NOTE : null,
    violations: pcList(view.violations).map((v) => ({hard: v.severity === 'hard', text: pcStr(v.message)})),
    hints: gate === 'plan' ? hints.filter((h) => !pcPlanCheck(h) && (!review || !/^(?:plan review\b|plan not reviewed\b|notes on an earlier version:)/i.test(h))) : hints,
    checks, review, decisions, lessons,
    lessonWaitTurn: turnRunning ? PC_WAIT_TURN : null,
    backlog: backlog && {summary: backlog.summary, items: backlog.items, waitTurn: turnRunning ? PC_WAIT_TURN : null},
    milestones,
    summary: current && current.summary ? pcStr(current.summary) : null,
    // Issue #126: the runtime's notes, apart from the director's report, and the report's unsupported claims.
    reportNotes: current ? pcList(current.reportNotes).map(pcStr).filter(Boolean) : [],
    claimWarnings: current ? pcList(current.directorReportWarnings).map(pcStr).filter(Boolean).map(pcClaimWarning) : [],
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
function pcDrawAssessment(doc, body, title, results, summary) {
  if (!results.length && !summary) return;
  const section = pcEl(doc, 'section', 'pc-assessment');
  section.appendChild(pcEl(doc, 'h3', 'pc-section-title', title));
  if (summary) section.appendChild(pcEl(doc, 'p', 'pc-hint', summary));
  for (const r of results) {
    const details = pcEl(doc, 'details', 'pc-assessment-item');
    details.appendChild(pcEl(doc, 'summary', 'pc-result is-' + r.verdict, r.dimension + ' · ' + r.verdict));
    if (r.detail) details.appendChild(pcEl(doc, 'p', 'pc-assessment-detail', pcStr(r.detail)));
    const ids = pcList(r.taskIds).map(pcStr).filter(Boolean);
    if (ids.length) details.appendChild(pcEl(doc, 'p', 'pc-meta', 'Tasks: ' + ids.join(', ')));
    section.appendChild(details);
  }
  body.appendChild(section);
}

function pcDrawDecisions(doc, body, model, on) {
  if (!model.decisions.length) return;
  body.appendChild(pcEl(doc, 'h3', 'pc-section-title', 'Brief decisions'));
  const list = pcEl(doc, 'ul', 'pc-rows');
  for (const d of model.decisions) {
    const item = pcEl(doc, 'li', 'pc-row');
    item.appendChild(pcEl(doc, 'div', 'pc-row-title', d.id + ' · ' + d.text));
    item.appendChild(pcEl(doc, 'div', 'pc-meta', d.status + ' · ' + (d.citedBy.length ? 'Cited by: ' + d.citedBy.join(', ') : 'No citing tasks')));
    for (const [label, status] of d.actions) {
      const button = pcButton(doc, label, 'btn btn-s xs', () => on({type: 'decision-status', id: d.id, status}), model.busy);
      button.setAttribute('aria-label', label + ' ' + d.id);
      item.appendChild(pcFocusKey(button, 'decision:' + d.id + ':' + status));
    }
    list.appendChild(item);
  }
  body.appendChild(list);
}

function pcDrawLessons(doc, body, model, on) {
  if (!model.lessons.length) return;
  const section = pcEl(doc, 'section', 'pc-lessons');
  section.setAttribute('aria-label', 'Lessons');
  section.appendChild(pcEl(doc, 'h3', 'pc-section-title', 'Lessons'));
  const waitTurn = model.lessonWaitTurn;
  if (waitTurn && model.lessons.some((lesson) => lesson.action)) {
    section.appendChild(pcEl(doc, 'p', 'pc-hint', waitTurn));
  }
  const list = pcEl(doc, 'ul', 'pc-rows');
  for (const lesson of model.lessons) {
    const li = pcEl(doc, 'li', 'pc-row');
    li.appendChild(pcEl(doc, 'div', 'pc-row-title', pcLessonPlain(lesson.id + ' · ' + lesson.title)));
    const cited = lesson.citedBy.length ? 'Cited by: ' + lesson.citedBy.join(', ') : 'No citing tasks';
    li.appendChild(pcEl(doc, 'div', 'pc-meta', (lesson.deferred ? 'deferred' : 'active') + ' · ' + cited));
    if (!lesson.deferred && lesson.missingFrom.length) {
      li.appendChild(pcEl(doc, 'div', 'pc-meta', 'Missing from: ' + lesson.missingFrom.join(', ')));
    }
    if (lesson.action) {
      const [label, status] = lesson.action;
      const button = pcButton(doc, label, 'btn btn-s xs',
        () => on({type: 'lesson-status', lesson: lesson.id, status, version: model.version}), model.busy || !!waitTurn, waitTurn);
      button.setAttribute('aria-label', label + ' ' + lesson.id);
      li.appendChild(pcFocusKey(button, 'lesson:' + lesson.id + ':' + status));
    }
    list.appendChild(li);
  }
  section.appendChild(list);
  body.appendChild(section);
}

/** Issue #146: the Backlog section, each item with the calls it takes (textContent only: items are author content). */
function pcDrawBacklog(doc, body, model, on) {
  const b = model.backlog;
  if (!b || !b.items.length) return;
  const section = pcEl(doc, 'section', 'pc-backlog');
  section.setAttribute('aria-label', 'Backlog');
  section.appendChild(pcEl(doc, 'h3', 'pc-section-title', 'Backlog'));
  section.appendChild(pcEl(doc, 'p', 'pc-meta', b.summary));
  if (b.waitTurn) section.appendChild(pcEl(doc, 'p', 'pc-hint', b.waitTurn));
  const off = model.busy || !!b.waitTurn;
  const list = pcEl(doc, 'ul', 'pc-rows');
  for (const item of b.items) {
    const li = pcEl(doc, 'li', 'pc-row pc-backlog-item is-' + item.state);
    li.appendChild(pcEl(doc, 'div', 'pc-row-title', item.title ? item.id + ' · ' + item.title : item.id));
    if (item.note) li.appendChild(pcEl(doc, 'div', 'pc-reason', item.note));
    if (item.meta) li.appendChild(pcEl(doc, 'div', 'pc-meta', item.meta));
    if (item.stale) li.appendChild(pcEl(doc, 'p', 'pc-warn-item', '⚠ ' + item.stale));
    if (item.cited) li.appendChild(pcEl(doc, 'div', 'pc-meta', item.cited));
    const acts = pcEl(doc, 'div', 'pc-item-actions');
    for (const [label, to] of item.actions) {
      const button = pcButton(doc, label, 'btn btn-s xs', () => on({type: 'backlog', id: item.id, state: to}), off, b.waitTurn);
      button.setAttribute('aria-label', label + ' ' + item.id);
      acts.appendChild(pcFocusKey(button, 'backlog:' + item.id + ':' + to));
    }
    for (const [label, status] of item.statusActions) {
      const button = pcButton(doc, label, 'btn btn-s xs', () => on({type: 'backlog-status', id: item.id, status}), off, b.waitTurn);
      button.setAttribute('aria-label', label + ' ' + item.id);
      acts.appendChild(pcFocusKey(button, 'backlog-status:' + item.id + ':' + status));
    }
    if (acts.children.length) li.appendChild(acts);
    list.appendChild(li);
  }
  section.appendChild(list);
  body.appendChild(section);
}

const PC_LESSON_SECTIONS = {decided: 'Decided', triedAndRuledOut: 'Tried and ruled out', watchOut: 'Watch out'};

// Keep author strings reviewable even when an older or remote agent supplies invisible characters.
function pcLessonPlain(text) {
  return pcStr(text).replace(/[\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u2028\u2029\uFFF9-\uFFFB\x00-\x09\x0B-\x1F\x7F-\x9F]/gu,
    (char) => '\\u{' + char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + '}');
}

function pcLessonSection(row, key, limit) {
  const text = pcStr(row.lesson.sections?.[key]);
  const ends = row.promptEnds?.[key];
  const standard = Number.isInteger(ends?.standard) ? Math.max(0, Math.min(text.length, ends.standard)) : text.length;
  const planning = Number.isInteger(ends?.planning) ? Math.max(0, Math.min(standard, ends.planning)) : standard;
  const parts = [];
  if (planning < standard) {
    parts.push({text: text.slice(0, planning)}, {mark: 'Model sees only up to here (shared planning budget).'});
  }
  parts.push({text: text.slice(planning < standard ? planning : 0, standard)});
  if (standard < text.length) {
    const cap = Number.isInteger(limit) ? limit + '-character limit' : 'standard limit';
    parts.push({mark: planning < standard ? 'Standard ' + cap + ' ends here.' : 'Model sees only up to here (' + cap + ').'});
    parts.push({text: text.slice(standard)});
  }
  return parts;
}

function pcLessonActions(row) {
  if (!row || !/^[a-f0-9]{64}$/.test(row.hash)) return [];
  if (!row.lesson) return ['reopen'];
  return [
    ...(row.lesson.declaredStatus === 'active' && row.status?.personState !== 'approved' ? ['approve'] : []),
    ...(row.status?.personState !== 'retired' ? ['retire'] : []),
    ...(row.hasChoice ? ['reopen'] : []),
  ];
}

function pcLessonMeta(row) {
  const {lesson, status} = row;
  const effective = status?.stale ? 'expired (file changed)' : status?.effectiveStatus === 'active' ? 'approved' : pcStr(status?.effectiveStatus);
  const source = lesson.source === 'person' ? 'person' : pcStr(lesson.source) + ' (declared by the director)';
  return pcLessonPlain(source + ' · declared: ' + pcStr(lesson.declaredStatus) + ' · effective: ' + effective);
}

function pcDrawLessonPanel(doc, host, model, on, focusKey, previousBody) {
  const {panel, row, busy, seen, blocked, notice, error} = model;
  const card = pcEl(doc, 'section', 'pc-card pc-lesson-panel');
  card.setAttribute('aria-label', 'Fusion project lessons');
  card.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    on({type: row ? 'lesson-list' : 'lesson-close'});
  });
  const head = card.appendChild(pcEl(doc, 'div', 'pc-head'));
  head.appendChild(pcEl(doc, 'div', 'pc-title', 'Fusion project lessons'));
  const button = (label, type, disabled = false, key = type, extra = {}) =>
    pcFocusKey(pcButton(doc, label, 'btn btn-g xs', () => on({type, ...extra}), disabled), key);
  if (row) head.appendChild(button('Back', 'lesson-list'));
  head.appendChild(button('Refresh', 'lesson-refresh', busy));
  head.appendChild(button('Close', 'lesson-close'));
  const body = card.appendChild(pcEl(doc, 'div', 'pc-body'));
  body.setAttribute('tabindex', '0');
  pcFocusKey(body, 'lesson-body');
  if (row) body.setAttribute('data-pc-lesson-body', row.id + '@' + row.hash);
  if (blocked) body.appendChild(pcEl(doc, 'p', 'pc-warn', blocked));
  if (notice) body.appendChild(pcEl(doc, 'p', 'pc-notice', notice)).setAttribute('role', 'status');
  if (error) body.appendChild(pcEl(doc, 'p', 'pc-error', error)).setAttribute('role', 'alert');
  if (busy) body.appendChild(pcEl(doc, 'p', 'pc-busy', 'Loading…')).setAttribute('role', 'status');
  if (row) {
    body.appendChild(pcEl(doc, 'code', 'pc-lesson-text', pcLessonPlain(row.id + '@' + row.hash)));
    if (row.lesson) {
      const {lesson} = row;
      body.appendChild(pcEl(doc, 'h3', 'pc-lesson-heading', pcLessonPlain(lesson.title)));
      body.appendChild(pcEl(doc, 'div', 'pc-meta', pcLessonMeta(row)));
      body.appendChild(pcEl(doc, 'div', 'pc-meta', 'always: ' + lesson.always + ' · touches: ' + (pcLessonPlain(pcList(lesson.touches).join(', ')) || '[]')));
      if (lesson.from) body.appendChild(pcEl(doc, 'div', 'pc-meta', 'From: ' + pcLessonPlain(lesson.from)));
      if (lesson.declaredStatus === 'proposed') {
        body.appendChild(pcEl(doc, 'p', 'pc-warn', 'Set status: active in ' + '.atomic/project/lessons/' + pcLessonPlain(row.id) + '.md and refresh.'));
      }
      for (const [key, label] of Object.entries(PC_LESSON_SECTIONS)) {
        const section = body.appendChild(pcEl(doc, 'section', 'pc-lesson-section'));
        section.appendChild(pcEl(doc, 'h4', 'pc-lesson-heading', label));
        for (const part of pcLessonSection(row, key, panel.sectionLimit)) {
          section.appendChild(part.mark ? pcEl(doc, 'p', 'pc-warn', part.mark) : pcEl(doc, 'div', 'pc-lesson-text', pcLessonPlain(part.text)));
        }
      }
    } else {
      body.appendChild(pcEl(doc, 'p', 'pc-warn', 'Missing or invalid lesson · previous choice: ' + pcLessonPlain(row.orphanedChoice)));
    }
  } else {
    const list = body.appendChild(pcEl(doc, 'ul', 'pc-rows'));
    for (const item of pcList(panel?.rows)) {
      const entry = list.appendChild(pcEl(doc, 'li', 'pc-row'));
      const title = item.lesson ? item.id + ' · ' + item.lesson.title : item.id;
      entry.appendChild(button(pcLessonPlain(title), 'lesson-read', false, 'read:' + item.id, {id: item.id}));
      const meta = item.lesson ? pcLessonMeta(item) : 'Missing or invalid · previous choice: ' + pcLessonPlain(item.orphanedChoice);
      entry.appendChild(pcEl(doc, 'div', 'pc-meta', meta));
      if (item.lesson) {
        entry.appendChild(pcEl(doc, 'div', 'pc-meta', 'always: ' + item.lesson.always + ' · touches: ' + (pcLessonPlain(pcList(item.lesson.touches).join(', ')) || '[]')));
      }
    }
    for (const problem of pcList(panel?.problems)) {
      body.appendChild(pcEl(doc, 'p', 'pc-warn', pcLessonPlain('Skipped ' + problem.file + ': ' + problem.reason)));
    }
    if (panel && !panel.rows?.length && !panel.problems?.length && !blocked && !error) {
      body.appendChild(pcEl(doc, 'p', 'pc-meta', 'No project lessons found.'));
    }
  }
  const actions = pcLessonActions(row);
  if (actions.length) {
    const foot = card.appendChild(pcEl(doc, 'div', 'pc-actions'));
    for (const action of actions) {
      const label = action[0].toUpperCase() + action.slice(1);
      foot.appendChild(button(label, 'lesson-choice', busy || !!blocked || (action === 'approve' && !seen), action, {action}));
    }
    if (actions.includes('approve') && !seen && !blocked && !busy) {
      foot.appendChild(pcEl(doc, 'span', 'pc-meta', 'Read to the end to enable approval.'));
    }
  }
  host.appendChild(card);
  const sameDetail = previousBody?.detail === body.getAttribute('data-pc-lesson-body');
  if (previousBody && sameDetail) body.scrollTop = previousBody.scrollTop;
  const restore = focusKey && pcFind(card, (el) => el.getAttribute?.('data-pc-focus') === focusKey);
  if (restore && !restore.disabled) restore.focus();
  else if (!sameDetail || focusKey) body.focus?.();
  if (row && !seen && actions.includes('approve') && !busy && !blocked) {
    const checkEnd = () => {
      if (body.isConnected && body.clientHeight > 0 && body.scrollTop + body.clientHeight >= body.scrollHeight - 1) {
        on({type: 'lesson-end', hash: row.hash});
      }
    };
    body.addEventListener('scroll', checkEnd);
    doc.defaultView?.requestAnimationFrame(checkEnd);
  }
}

function pcDraw(doc, host, model, on) {
  /* Accessibility: what had the focus is found again after the paint, by
     what it does; a correction box being typed in is kept as it is (the
     same node: its text and caret), never rebuilt under the person. */
  const active = doc.activeElement && host.contains && host.contains(doc.activeElement) ? doc.activeElement : null;
  const focusKey = active && active.getAttribute ? active.getAttribute('data-pc-focus') : null;
  const keepNote = focusKey === 'note' ? active : null;
  const oldLessonBody = model?.kind === 'lesson-panel'
    ? pcFind(host, (el) => !!el.getAttribute?.('data-pc-lesson-body')) : null;
  const previousLessonBody = oldLessonBody && {
    detail: oldLessonBody.getAttribute('data-pc-lesson-body'), scrollTop: oldLessonBody.scrollTop,
  };
  const caret = keepNote ? [keepNote.selectionStart, keepNote.selectionEnd] : null;
  while (host.firstChild) host.removeChild(host.firstChild);
  if (!model) { host.hidden = true; return; }
  host.hidden = false;
  if (model.kind === 'lesson-panel') { pcDrawLessonPanel(doc, host, model.lessonPanel, on, focusKey, previousLessonBody); return; }
  if (model.kind === 'problem') { pcDrawProblem(doc, host, model, on, focusKey); return; }
  if (model.kind === 'backlog') { pcDrawBacklogOnly(doc, host, model, on, focusKey); return; }
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
  model.warnings.forEach((w, i) => body.appendChild(pcEl(doc, 'p', model.changedOutside && i === 0 ? 'pc-warn pc-outside' : 'pc-warn', w)));
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
  pcDrawDecisions(doc, body, model, on);
  pcDrawLessons(doc, body, model, on);
  pcDrawAssessment(doc, body, 'Plan checks', model.checks);
  if (model.review) pcDrawAssessment(doc, body, 'Plan review', model.review.results, model.review.summary);
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
  pcDrawBacklog(doc, body, model, on);
  if (model.milestones.length) {
    const ul = pcEl(doc, 'ul', 'pc-milestones');
    for (const m of model.milestones) {
      const li = pcEl(doc, 'li', 'pc-milestone is-' + m.state.replace(/[^a-z_]/g, '') + (m.current ? ' is-current' : ''),
        m.mark + ' ' + m.title + (m.kind ? ' (' + m.kind + ')' : '') + ' — ' + m.state.replace('_', ' ') + (m.estimate ? ' · ' + m.estimate : ''));
      if (m.evidence) {
        // Issue #119: the receipts summary, then where to verify it in full.
        li.appendChild(pcEl(doc, 'p', 'pc-evidence is-' + m.evidence.tone, m.evidence.line));
        if (m.evidence.hint) li.appendChild(pcEl(doc, 'p', 'pc-evidence pc-evidence-hint is-' + m.evidence.tone, m.evidence.hint));
      }
      if (m.basis) li.appendChild(pcEl(doc, 'p', 'pc-basis', m.basis));
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
  if (model.summary) body.appendChild(pcEl(doc, 'p', 'pc-summary', 'Director report: ' + model.summary));
  for (const n of model.reportNotes) body.appendChild(pcEl(doc, 'p', 'pc-report-note', n));
  for (const w of model.claimWarnings) body.appendChild(pcEl(doc, 'p', 'pc-warn-item pc-claim-warning', w));
  for (const c of model.corrections) body.appendChild(pcEl(doc, 'p', 'pc-correction', 'Earlier correction: ' + c));
  if (model.notice) {
    const n = body.appendChild(pcEl(doc, 'p', 'pc-notice', model.notice));
    n.setAttribute('role', 'status'); n.setAttribute('aria-live', 'polite');
  }
  if (model.error) body.appendChild(pcEl(doc, 'p', 'pc-error', model.error)).setAttribute('role', 'alert');
  const bar = pcEl(doc, 'div', 'pc-actions');
  if (model.review?.warning) bar.appendChild(pcEl(doc, 'p', 'pc-warn pc-review-warning', model.review.warning));
  if (model.mode === 'correct' || model.mode === 'override') {
    const override = model.mode === 'override';
    let ta = keepNote;
    if (!ta) {
      ta = pcFocusKey(pcEl(doc, 'textarea', 'pc-note'), 'note');
      ta.maxLength = model.noteMax;
      ta.placeholder = override ? 'Why are you approving over review?' : 'What should the milestone do differently?';
      ta.setAttribute('aria-label', override ? 'Reason for approving over review (required)' : 'Your correction');
      if (override) ta.required = true;
      ta.value = model.note;
      // The text stays in its own box between paints; only the counter follows it.
      ta.addEventListener('input', () => { if (ta._pcCount) ta._pcCount.textContent = ta.value.length + ' / ' + model.noteMax; on({type: 'note', note: ta.value}); });
    }
    ta.disabled = !!model.busy;
    const count = pcEl(doc, 'div', 'pc-count', ta.value.length + ' / ' + model.noteMax);
    ta._pcCount = count;
    body.appendChild(ta);
    body.appendChild(count);
    bar.appendChild(pcFocusKey(pcButton(doc, override ? 'Approve over review' : 'Send correction', 'btn btn-p sm', () => on({type: 'verdict', verdict: override ? 'approveOverReview' : 'edit'}), model.busy), override ? 'send-override' : 'send-correction'));
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
    else if (focusKey === 'verdict:approveOverReview' && model.mode === 'override') {
      pcFind(card, (e) => e.getAttribute && e.getAttribute('data-pc-focus') === 'note')?.focus();
    }
  }
}

/** Issue #146: the backlog card between gates and at the close; Hide and the items' calls are its buttons. */
function pcDrawBacklogOnly(doc, host, model, on, focusKey) {
  const card = pcEl(doc, 'section', 'pc-card pc-backlog-card');
  card.setAttribute('aria-label', 'Fusion project');
  const head = pcEl(doc, 'div', 'pc-head');
  head.appendChild(pcEl(doc, 'div', 'pc-title', model.headline));
  head.appendChild(pcFocusKey(pcButton(doc, 'Hide', 'btn btn-g xs', () => on({type: 'hide'}), false, 'Put the card away; reopening the chat shows it again'), 'hide'));
  card.appendChild(head);
  const body = pcEl(doc, 'div', 'pc-body');
  card.appendChild(body);
  for (const line of model.completion) body.appendChild(pcEl(doc, 'p', 'pc-warn', line));
  pcDrawBacklog(doc, body, model, on);
  if (model.notice) {
    const n = body.appendChild(pcEl(doc, 'p', 'pc-notice', model.notice));
    n.setAttribute('role', 'status'); n.setAttribute('aria-live', 'polite');
  }
  if (model.error) body.appendChild(pcEl(doc, 'p', 'pc-error', model.error)).setAttribute('role', 'alert');
  if (model.busy) {
    const bar = pcEl(doc, 'div', 'pc-actions');
    bar.appendChild(pcEl(doc, 'span', 'pc-busy', 'Sending…'));
    card.appendChild(bar);
  }
  host.appendChild(card);
  if (focusKey) { const next = pcFind(card, (e) => e.getAttribute && e.getAttribute('data-pc-focus') === focusKey); if (next) next.focus(); }
}

/** The problem card (issue #109): what went wrong and what to do; Hide is its only button. */
function pcDrawProblem(doc, host, model, on, focusKey) {
  const card = pcEl(doc, 'section', 'pc-card pc-problem');
  card.setAttribute('aria-label', 'Fusion project');
  card.setAttribute('role', 'alert');
  const head = pcEl(doc, 'div', 'pc-head');
  head.appendChild(pcEl(doc, 'div', 'pc-title', model.headline));
  head.appendChild(pcFocusKey(pcButton(doc, 'Hide', 'btn btn-g xs', () => on({type: 'hide'}), false, 'Put the card away; reopening the chat shows it again'), 'hide'));
  card.appendChild(head);
  const body = pcEl(doc, 'div', 'pc-body');
  body.appendChild(pcEl(doc, 'p', 'pc-error', model.problem));
  body.appendChild(pcEl(doc, 'p', 'pc-hint', model.todo));
  card.appendChild(body);
  host.appendChild(card);
  if (focusKey === 'hide') { const b = pcFind(card, (e) => e.getAttribute && e.getAttribute('data-pc-focus') === 'hide'); if (b) b.focus(); }
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
 * `api.read(sid, evidence?)` → AgentClient.getProject's answer; `api.decide(body)` →
 * projectDecision's. `onContinue(sid, text)` sends the next message and
 * answers whether it went (false: kept until that chat is on screen).
 * `onRevise()` puts the caret in the composer. `draw(model)` paints.
 */
function createProjectCard(opts) {
  const store = pcStore();
  const pending = new Map();   // sid → continue message not sent yet
  const hidden = new Set();    // the gates the person put away in the chat on screen (sid, gate, version)
  const frames = new Map();    // sid → frames seen, so a read answered after a frame does not overwrite it
  // Issue #74: the gates a decision is in flight for (sid, gate, version), so leaving the chat and coming back keeps them busy.
  const deciding = new Set();
  const backlogDeciding = new Set();   // issue #146: the chats a backlog call is in flight for (it moves no gate, so by sid)
  const problems = new Map();  // issue #109: sid → why its project could not be opened (the last read's)
  let sid = null, state = pcInitial(null), serial = 0, cancelTimer = null;
  let evidenceFor = null, evidenceReceipts;
  let lessons = null;
  const lessonWriting = new Set();
  const projectChats = new Set();
  const canBrowseLessons = () => !!(sid && projectChats.has(sid) && opts.api.lessons);
  const selectedLesson = () => pcList(lessons?.panel?.rows).find((row) => row.id === lessons.id);
  const lessonBlocked = () => turnRunning() ? 'Wait for the turn to finish.' : lessons?.panel?.blocked;

  const key = () => {
    const v = state.view;
    return v ? JSON.stringify([sid, v.gate.kind, v.gate.id || '', v.version]) : '';
  };
  const changed = () => { if (opts.onChange) opts.onChange(); };
  const notify = changed;
  // Issue #146: whether a turn runs in the chat on screen (the page's own state); read at each paint.
  const turnRunning = () => !!(sid && opts.turnRunning && opts.turnRunning(sid));
  let paintedRunning = false;
  function paint() {
    paintedRunning = turnRunning();
    let cardState = state;
    if (evidenceFor === state.view && evidenceReceipts) {
      const view = state.view;
      const milestones = pcList(view.milestones).map((m) => m.id === view.gate.id ? {...m, evidenceReceipts} : m);
      cardState = {...state, view: {...view, milestones}};
    }
    let model = sid && !hidden.has(key()) ? pcModel(cardState, {turnRunning: paintedRunning}) : null;
    if (!model && sid && !pcShown(state.view) && problems.has(sid) && !hidden.has('problem:' + sid)) model = pcProblemModel(problems.get(sid));
    if (lessons) model = {kind: 'lesson-panel', lessonPanel: {
      ...lessons, row: selectedLesson(), blocked: lessonBlocked(),
    }};
    opts.draw(model, act);
  }
  async function readEvidence() {
    const source = state.view;
    if (!sid || !pcOpen(source) || source.gate.kind !== 'milestone' || hidden.has(key()) || evidenceFor === source) return;
    const asked = sid, mine = serial;
    // The same view can arrive on both the chat and the global event stream.
    // Keep the optional reply separate so it cannot replace that view.
    evidenceFor = source;
    evidenceReceipts = undefined;
    try {
      const res = await opts.api.read(asked, true);
      const view = res?.ok && res.view;
      if (mine !== serial || source !== state.view || evidenceFor !== source ||
          view?.gate?.kind !== 'milestone' || view.gate.id !== source.gate.id || view.version !== source.version) return;
      evidenceReceipts = pcList(view.milestones).find((m) => m.id === view.gate.id)?.evidenceReceipts;
      if (evidenceReceipts) paint();
    } catch {
      // The card already has its ordinary view.
    }
  }
  function setView(view, notice) {
    state = pcReduce(state, {type: 'view', view, notice});
  }
  async function loadLessons(choice) {
    const shown = lessons, here = sid, frame = frames.get(sid);
    if (!shown || shown.busy || lessonWriting.has(here)) return;
    shown.busy = true;
    shown.seen = false;
    shown.notice = shown.error = null;
    if (choice) lessonWriting.add(here);
    paint();
    let response;
    try {
      response = choice ? await opts.api.lessonChoice(choice) : await opts.api.lessons(here);
    } catch (error) {
      response = {error: String(error)};
    } finally {
      if (choice) lessonWriting.delete(here);
    }
    if (here === sid && choice && response?.ok && response.view && frames.get(here) === frame && store.put(here, response.view)) {
      state = pcReduce(state, {type: 'view', view: store.get(here), inFlight: state.busy});
      if (!lessons) paint();
    }
    if (shown !== lessons || here !== sid) {
      if (here === sid && lessons) void loadLessons();
      return;
    }
    shown.busy = false;
    shown.panel = response?.panel ?? null;
    shown.notice = response?.notice;
    shown.error = response?.ok ? null : response?.supported === false
      ? 'This agent does not support Fusion project lessons.' : response?.error || 'Could not load Fusion project lessons.';
    paint();
  }
  function openLessons() {
    if (!canBrowseLessons() || lessons || lessonWriting.has(sid)) return;
    lessons = {panel: null, id: null, seen: false, busy: false};
    return loadLessons();
  }
  function chooseLesson(action) {
    const row = selectedLesson();
    if (!lessons || lessons.busy || lessonBlocked() || !opts.api.lessonChoice ||
        !pcLessonActions(row).includes(action) || (action === 'approve' && !lessons.seen)) return;
    return loadLessons({
      session: sid, lesson: row.id, action, fingerprint: row.hash, ...(row.lesson ? {} : {orphaned: true}),
    });
  }
  function act(a) {
    switch (a.type) {
      case 'lesson-close': lessons = null; return paint();
      case 'lesson-refresh': return loadLessons();
      case 'lesson-list':
      case 'lesson-read':
        if (!lessons) return;
        lessons.id = a.type === 'lesson-read' ? a.id : null;
        lessons.seen = false;
        return paint();
      case 'lesson-end':
        if (!lessons || lessons.seen || selectedLesson()?.hash !== a.hash || lessonBlocked()) return;
        lessons.seen = true;
        return paint();
      case 'lesson-choice': return chooseLesson(a.action);
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
      case 'decision-status': return decide('edit', a);
      case 'backlog':
      case 'backlog-status':
      case 'lesson-status':
        if (turnRunning()) { state = pcReduce(state, {type: 'failed', error: 'A turn is running in this chat. ' + PC_WAIT_TURN + '.'}); return paint(); }
        if (a.type === 'lesson-status') return decide('edit', a);
        return a.type === 'backlog' ? backlogCall(a.id, a.state) : decide('edit', {backlog: a.id, status: a.status});
      case 'worker': state = pcReduce(state, {type: 'worker', taskId: a.taskId, worker: a.value}); return paint();
      case 'reviewer': state = pcReduce(state, {type: 'reviewer', taskId: a.taskId, reviewer: a.value}); return paint();
      case 'note': state = pcReduce(state, {type: 'note', note: a.note}); return;   // the textarea keeps its own text
      case 'hide': hidden.add(pcShown(state.view) ? key() : 'problem:' + sid); paint(); return changed();
      case 'revise': if (opts.onRevise) opts.onRevise(); state = pcReduce(state, {type: 'notice', notice: 'Say in the chat what to change; the director drafts the brief again.'}); return paint();
      default: state = pcReduce(state, {type: a.type}); return paint();
    }
  }
  async function decide(verdict, statusEdit) {
    const gate = key();
    if (state.busy || deciding.has(gate) || backlogDeciding.has(sid)) return;
    const here = sid;
    const built = pcDecision(state, here, verdict, statusEdit);
    if (built.error) { state = pcReduce(state, {type: 'failed', error: built.error}); return paint(); }
    deciding.add(gate);
    state = pcReduce(state, {type: 'sending'}); paint();
    const res = await Promise.resolve().then(() => opts.api.decide(built.body)).catch((e) => ({supported: true, ok: false, status: 0, code: null, error: String(e)}));
    deciding.delete(gate);
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
  /* Issue #146: the person's call on a backlog item. It moves no gate, so the
     card stays on the same gate; the agent answers with the view it leaves. */
  async function backlogCall(id, to) {
    if (state.busy || deciding.has(key()) || backlogDeciding.has(sid)) return;
    const here = sid;
    const built = pcBacklogCall(state, here, id, to);
    if (built.error) { state = pcReduce(state, {type: 'failed', error: built.error}); return paint(); }
    backlogDeciding.add(here);
    const seen = frames.get(here) || 0;
    state = pcReduce(state, {type: 'sending'}); paint();
    const call = opts.api.backlog ? () => opts.api.backlog(built.body) : () => ({supported: false});
    const res = await Promise.resolve().then(call).catch((e) => ({supported: true, ok: false, status: 0, code: null, error: String(e)}));
    backlogDeciding.delete(here);
    const out = pcBacklogOutcome(res, id, to);
    // A frame that came while the call was out is newer than its answer, as for follow()'s read.
    const newer = (frames.get(here) || 0) !== seen;
    if (out.closed && !newer) store.drop(here);
    else if (out.view && !newer) store.put(here, out.view);
    if (here !== sid) return;
    setView(store.get(here), out.notice);
    if (out.error) state = pcReduce(state, {type: 'failed', error: out.error});
    else if (out.notice && state.view) state = pcReduce(state, {type: 'notice', notice: out.notice});
    else state.busy = false;
    paint(); notify();
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
      const newProject = frame.view?.schema === 1 && !projectChats.has(frame.sessionId);
      if (newProject) projectChats.add(frame.sessionId);
      const changed = store.put(frame.sessionId, frame.view);
      if (frame.sessionId !== sid) return;
      if (changed) {
        state = pcReduce(state, {type: 'view', view: store.get(sid), inFlight: state.busy});
        paint(); notify();
      }
      if (newProject && !changed) notify();
      void readEvidence();
    },
    /** The chat on screen is `next` (null: none, or not saved yet). Reads its view once per change. */
    follow(next) {
      next = next || null;
      // The page paints on every change of its own; a turn that started or finished redraws the card.
      if (next === sid) {
        if (turnRunning() !== paintedRunning) {
          paint(); notify();
          if (lessons && !paintedRunning) void loadLessons();
        }
        flush();
        return;
      }
      // Hide lasts while the chat stays on screen: opening it again shows its card.
      hidden.clear();
      sid = next; serial++;
      lessons = null;
      evidenceFor = null;
      evidenceReceipts = undefined;
      state = pcInitial(sid ? store.get(sid) : null);
      if (deciding.has(key()) || backlogDeciding.has(sid)) state.busy = true;   // issue #74: its decision has not answered yet
      paint();
      notify();
      flush();
      if (!sid) return;
      const mine = serial, asked = sid, seen = frames.get(asked) || 0;
      Promise.resolve().then(() => opts.api.read(asked)).then((res) => {
        if (mine !== serial || !res || res.supported === false || !res.ok) return;
        if ((frames.get(asked) || 0) !== seen) return;   // a frame came after the read went out: it is newer
        const hadProject = projectChats.has(asked);
        if (res.view?.schema === 1) projectChats.add(asked); else projectChats.delete(asked);
        const was = problems.get(asked);
        if (!res.view && typeof res.problem === 'string' && res.problem) problems.set(asked, res.problem); else problems.delete(asked);
        const changed = (res.view ? store.put(asked, res.view) : store.drop(asked)) || problems.get(asked) !== was;
        if (changed) { state = pcReduce(state, {type: 'view', view: store.get(asked), inFlight: state.busy}); paint(); notify(); }
        if (!changed && hadProject !== projectChats.has(asked)) notify();
        void readEvidence();
      }).catch(() => undefined);
    },
    /* Another agent is on the wire (a restart, a remote one): what the last
       one said is not this one's, except a continue message still owed to a
       chat, which the person's decision already recorded. `next` is the chat
       the page shows now (null: none); left out, the one followed so far. */
    reset(next) { const keep = next === undefined ? sid : next; store.clear(); problems.clear(); hidden.clear(); projectChats.clear(); lessons = null; sid = null; state = pcInitial(null); this.follow(keep); },
    /** Whether the chat on screen has an open gate the person hid (the header offers Show Fusion project). */
    hiddenOpen() { return !!sid && pcShown(state.view) && !(pcBacklogOnly(state.view) && turnRunning()) && hidden.has(key()); },
    /** Show Fusion project: the hidden card again. */
    show() { if (hidden.delete(key())) { paint(); changed(); void readEvidence(); } },
    canBrowseLessons, openLessons,
    state: () => state,
    store,
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    PC_NOTE_MAX, PC_WRITE_SCOPE_NOTE, PC_FACT_MARK, PC_MILESTONE_KIND_LABEL, PC_PLAN_UNTRUSTED, PC_BRIEF_UNTRUSTED,
    PC_CHANGED_OUTSIDE_HINT, PC_PROBLEM_HEADLINE, pcChangedOutsideWarning, pcProblemModel,
    pcStore, pcInitial, pcReduce, pcDecision, pcOutcome, pcModel, pcDraw, pcEditRows,
    pcLessonSection, pcBacklogModel, pcBacklogCall, pcBacklogOutcome, pcBacklogOnly, pcCompletion,
    pcWorkerOptions, pcReviewerOptions, pcUsd, pcDuration, createProjectCard, pcRef, pcPlace, PC_NARROW_PX, pcCanContinue, pcWatch,
  };
}
