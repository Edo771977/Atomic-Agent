// Issue #39: the fusion project card (renderer/project-card.js): the newest
// view per chat, the edit reducer, the decision body, refusals, the lines it
// draws and the DOM it builds (textContent only), and the controller that
// sends continue_message as the chat's next message.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../renderer/project-card.js');

function row(over = {}) {
  return Object.assign({
    taskId: 't1', title: 'Board and pieces', milestoneId: 'm1', worker: 'openrouter:w-a', reviewer: 'openrouter:r-a',
    reason: 'cheapest worker that passed similar tasks', basis: 'measured', samples: 3, estCostUsd: 0.12, estMs: 95_000,
    selectableWorkers: ['openrouter:w-a', 'openrouter:w-b'], selectableReviewers: ['openrouter:r-a', 'openrouter:r-b'],
  }, over);
}
function plan(over = {}) {
  return Object.assign({
    schema: 1, sessionId: 'ses-1', gate: {kind: 'plan'}, version: 3,
    allowedVerdicts: ['approve', 'edit', 'cheaper', 'quality', 'cancel'],
    expectation: {kind: 'await_person', gate: {kind: 'plan'}}, cancelled: false,
    brief: {version: 1, what: 'A chess game', users: 'me', how: 'browser', successCriteria: ['legal moves only'], status: 'approved', draftedAfterUntrusted: false},
    plan: {status: 'draft', detail: 'compact', version: 2, draftedAfterUntrusted: false,
      rows: [row(), row({taskId: 't2', title: 'Rules engine', milestoneId: 'm2', basis: 'preset', samples: 0, estCostUsd: null, estMs: null, reviewer: null})],
      totals: {costUsd: 0.12, ms: 95_000, unknownCostRows: 1}},
    milestones: [
      {id: 'm1', title: 'Base', kind: 'base', state: 'planned', runIds: [], updatedAt: 1, estCostUsd: 0.12, estMs: 95_000},
      {id: 'm2', title: 'Logic', kind: 'logic', state: 'planned', runIds: [], updatedAt: 1, estCostUsd: null, estMs: null},
    ],
    violations: [],
  }, over);
}
function milestone(over = {}) {
  return plan(Object.assign({
    gate: {kind: 'milestone', id: 'm1'}, version: 5, allowedVerdicts: ['approve', 'edit', 'cancel'],
    milestones: [
      {id: 'm1', title: 'Base', kind: 'base', state: 'done', runIds: ['r1'], summary: 'The board renders.', updatedAt: 2, estCostUsd: 0.1, estMs: 1000,
        corrections: [{note: 'Bigger squares', at: 1}]},
      {id: 'm2', title: 'Logic', kind: 'logic', state: 'approved', runIds: [], updatedAt: 1, estCostUsd: null, estMs: null},
    ],
  }, over));
}
const brief = (over = {}) => plan(Object.assign({gate: {kind: 'brief'}, version: 1, allowedVerdicts: ['approve', 'edit', 'cancel'], plan: null, milestones: [],
  brief: {version: 1, what: 'A chess game', users: 'me', how: 'browser', successCriteria: ['legal moves only'], status: 'draft', draftedAfterUntrusted: true}}, over));
const closed = (version = null) => plan({gate: {kind: 'none'}, version, allowedVerdicts: ['cancel'], expectation: {kind: 'run_milestone', id: 'm1'}});

/* ---------------- the core's own sentences ---------------- */

test('the write-scope note and the untrusted warnings are the core\'s sentences', () => {
  const core = readFileSync(new URL('../../src/session/project-gate-text.ts', import.meta.url), 'utf8');
  const constant = (name) => JSON.parse(core.match(new RegExp(`export const ${name} =\\s*\\n?\\s*("(?:[^"\\\\]|\\\\.)*")`))[1]);
  assert.equal(C.PC_WRITE_SCOPE_NOTE, constant('PROJECT_WRITE_SCOPE_NOTE'));
  assert.equal(C.PC_PLAN_UNTRUSTED, constant('PLAN_UNTRUSTED_WARNING'));
  assert.ok(core.includes(C.PC_BRIEF_UNTRUSTED.slice(2)), 'brief warning');
  const parse = readFileSync(new URL('../../src/session/project-decision-parse.ts', import.meta.url), 'utf8');
  assert.equal(C.PC_NOTE_MAX, Number(parse.match(/MAX_PROJECT_NOTE_CHARS = (\d+)/)[1]));
});

/* ---------------- newest version only ---------------- */

test('the store keeps only the newest version, and a closed gate is not reopened by a late copy', () => {
  const st = C.pcStore();
  assert.equal(st.put('ses-1', plan({version: 3})), true);
  assert.equal(st.put('ses-1', plan({version: 3})), false, 'the same view again changes nothing');
  assert.equal(st.put('ses-1', plan({version: 2})), false, 'an older version is dropped');
  assert.equal(st.get('ses-1').version, 3);
  assert.equal(st.put('ses-1', plan({version: 4})), true);
  assert.equal(st.put('ses-1', closed()), true, 'the gate closed');
  assert.equal(st.get('ses-1'), null);
  assert.equal(st.put('ses-1', plan({version: 4})), false, 'a replay of the closed gate');
  assert.equal(st.put('ses-1', milestone({version: 5})), true);
  assert.equal(st.put('other', plan({schema: 2})), false);
  assert.equal(st.put('', plan()), false);
  assert.equal(st.put('ses-1', plan({version: 6, cancelled: true, allowedVerdicts: []})), true, 'a cancelled project closes the card');
  assert.equal(st.get('ses-1'), null);
});

/* ---------------- what the card shows ---------------- */

test('the plan card: rows with worker, reviewer, reason, basis and estimate, totals, the write-scope note, milestones', () => {
  const m = C.pcModel(C.pcInitial(plan()));
  assert.equal(m.headline, 'The project plan waits for your approval');
  assert.equal(m.version, 3);
  assert.deepEqual(m.rows.map((r) => [r.taskId, r.worker, r.reviewer, r.basis, r.estimate]), [
    ['t1', 'openrouter:w-a', 'openrouter:r-a', 'measured (3 runs)', '$0.12 · ~1m35s'],
    ['t2', 'openrouter:w-a', null, 'preset', 'cost unknown · time unknown'],
  ]);
  assert.equal(m.rows[0].reason, 'cheapest worker that passed similar tasks');
  assert.equal(m.totals, '2 tasks · $0.12 (+1 unpriced) · ~1m35s');
  assert.equal(m.scopeNote, C.PC_WRITE_SCOPE_NOTE);
  assert.deepEqual(m.milestones.map((x) => x.mark + ' ' + x.title), ['· Base', '· Logic']);
  assert.deepEqual(m.actions.map((a) => a.verdict), ['approve', 'edit', 'cheaper', 'quality', 'cancel']);
  assert.deepEqual(m.brief, [{label: 'What', text: 'A chess game'}]);
});

test('only the verdicts the view allows become buttons', () => {
  const m = C.pcModel(C.pcInitial(plan({allowedVerdicts: ['approve', 'cancel']})));
  assert.deepEqual(m.actions.map((a) => a.label), ['Approve', 'Cancel project']);
  assert.equal(C.pcModel(C.pcInitial(closed())), null, 'nothing to decide, no card');
  const b = C.pcModel(C.pcInitial(brief()));
  assert.deepEqual(b.actions.map((a) => a.label), ['Approve', 'Revise in chat', 'Cancel project']);
  const ms = C.pcModel(C.pcInitial(milestone()));
  assert.deepEqual(ms.actions.map((a) => a.label), ['Approve milestone', 'Correct…', 'Cancel project']);
});

test('the brief card warns when it was drafted after outside content, and shows the whole brief', () => {
  const m = C.pcModel(C.pcInitial(brief()));
  assert.deepEqual(m.warnings, [C.PC_BRIEF_UNTRUSTED]);
  assert.deepEqual(m.brief.map((l) => l.label), ['What', 'For', 'How']);
  assert.deepEqual(m.criteria, ['legal moves only']);
  assert.deepEqual(m.rows, []);
  assert.equal(m.scopeNote, null);
  const p = C.pcModel(C.pcInitial(plan({plan: Object.assign(plan().plan, {draftedAfterUntrusted: true})})));
  assert.deepEqual(p.warnings, [C.PC_PLAN_UNTRUSTED]);
});

test('a hard violation is marked and holds Approve back; a warning does not', () => {
  const view = plan({violations: [
    {kind: 'turn-budget', severity: 'hard', message: 'The plan costs $3.10; the turn budget is $2.00'},
    {kind: 'local-slots', severity: 'warn', message: 'Two local workers share one slot'},
  ]});
  const m = C.pcModel(C.pcInitial(view));
  assert.deepEqual(m.violations, [{hard: true, text: 'The plan costs $3.10; the turn budget is $2.00'}, {hard: false, text: 'Two local workers share one slot'}]);
  const approve = m.actions.find((a) => a.verdict === 'approve');
  assert.equal(approve.disabled, true);
  assert.match(approve.why, /hard limit/);
  assert.match(C.pcDecision(C.pcInitial(view), 'ses-1', 'approve').error, /hard limits/);
  assert.ok(C.pcDecision(C.pcInitial(view), 'ses-1', 'cheaper').body);
  const warnOnly = plan({violations: [{kind: 'local-slots', severity: 'warn', message: 'x'}]});
  assert.equal(C.pcModel(C.pcInitial(warnOnly)).actions[0].disabled, false);
});

test('the milestone card shows the result, earlier corrections and the gate milestone', () => {
  const m = C.pcModel(C.pcInitial(milestone()));
  assert.equal(m.headline, 'Milestone “Base” is done and waits for your review');
  assert.equal(m.summary, 'The board renders.');
  assert.deepEqual(m.corrections, ['Bigger squares']);
  assert.deepEqual(m.milestones.map((x) => [x.mark, x.current]), [['✓', true], ['▸', false]]);
  assert.equal(m.scopeNote, null);
});

/* ---------------- edits and decisions ---------------- */

test('edit rows: picks only among the row\'s selectable workers and reviewers, and only changed rows are sent', () => {
  let s = C.pcInitial(plan());
  s = C.pcReduce(s, {type: 'worker', taskId: 't1', worker: 'openrouter:w-b'});
  assert.deepEqual(s.picks, {}, 'not in edit mode');
  s = C.pcReduce(s, {type: 'edit'});
  assert.equal(s.mode, 'edit');
  s = C.pcReduce(s, {type: 'worker', taskId: 't1', worker: 'openrouter:not-on-the-team'});
  assert.deepEqual(s.picks, {}, 'a worker the row does not offer');
  s = C.pcReduce(s, {type: 'worker', taskId: 't1', worker: 'openrouter:w-b'});
  s = C.pcReduce(s, {type: 'reviewer', taskId: 't1', reviewer: null});
  s = C.pcReduce(s, {type: 'reviewer', taskId: 't2', reviewer: 'openrouter:r-b'});
  s = C.pcReduce(s, {type: 'reviewer', taskId: 't2', reviewer: 'openrouter:evil'});
  assert.deepEqual(C.pcEditRows(s), [{taskId: 't1', worker: 'openrouter:w-b', reviewer: null}, {taskId: 't2', reviewer: 'openrouter:r-b'}]);
  const m = C.pcModel(s);
  assert.equal(m.rows[0].worker, 'openrouter:w-b');
  assert.equal(m.rows[0].changed, true);
  assert.equal(m.changedRows, 2);
  assert.deepEqual(C.pcDecision(s, 'ses-1', 'edit').body, {session: 'ses-1', gate: {kind: 'plan'}, version: 3, verdict: 'edit',
    edits: {rows: [{taskId: 't1', worker: 'openrouter:w-b', reviewer: null}, {taskId: 't2', reviewer: 'openrouter:r-b'}]}});
  // Picking the row's own value again is no change.
  s = C.pcReduce(s, {type: 'worker', taskId: 't1', worker: 'openrouter:w-a'});
  s = C.pcReduce(s, {type: 'reviewer', taskId: 't1', reviewer: 'openrouter:r-a'});
  assert.deepEqual(C.pcEditRows(s), [{taskId: 't2', reviewer: 'openrouter:r-b'}]);
  s = C.pcReduce(s, {type: 'back'});
  assert.match(C.pcDecision(C.pcReduce(s, {type: 'edit'}), 'ses-1', 'edit').error, /another worker/);
});

test('a row whose current worker is no longer selectable still lists it first', () => {
  const r = row({worker: 'openrouter:gone', reviewer: 'openrouter:gone-r'});
  assert.deepEqual(C.pcWorkerOptions(r), ['openrouter:gone', 'openrouter:w-a', 'openrouter:w-b']);
  assert.deepEqual(C.pcReviewerOptions(r), ['openrouter:gone-r', 'openrouter:r-a', 'openrouter:r-b', null]);
});

test('a milestone correction carries the note, at most 2000 characters', () => {
  let s = C.pcReduce(C.pcInitial(milestone()), {type: 'correct'});
  assert.equal(s.mode, 'correct');
  assert.match(C.pcDecision(s, 'ses-1', 'edit').error, /what to correct/);
  s = C.pcReduce(s, {type: 'note', note: 'Use a wooden board'});
  assert.deepEqual(C.pcDecision(s, 'ses-1', 'edit').body, {session: 'ses-1', gate: {kind: 'milestone', id: 'm1'}, version: 5, verdict: 'edit', edits: {note: 'Use a wooden board'}});
  s = C.pcReduce(s, {type: 'note', note: 'x'.repeat(5000)});
  assert.equal(s.note.length, C.PC_NOTE_MAX);
  assert.ok(C.pcDecision(s, 'ses-1', 'edit').body);
  assert.deepEqual(C.pcDecision(C.pcInitial(milestone()), 'ses-1', 'approve').body, {session: 'ses-1', gate: {kind: 'milestone', id: 'm1'}, version: 5, verdict: 'approve'});
  assert.match(C.pcDecision(C.pcInitial(milestone()), 'ses-1', 'cheaper').error, /does not take/);
  assert.equal(C.pcReduce(C.pcInitial(plan()), {type: 'correct'}).mode, 'view', 'no note at the plan');
});

test('a newer version while editing sets the edits aside and says so', () => {
  let s = C.pcReduce(C.pcInitial(plan()), {type: 'edit'});
  s = C.pcReduce(s, {type: 'worker', taskId: 't1', worker: 'openrouter:w-b'});
  s = C.pcReduce(s, {type: 'view', view: plan({version: 4})});
  assert.equal(s.mode, 'view');
  assert.deepEqual(s.picks, {});
  assert.match(s.notice, /version 4/);
  const same = C.pcReduce(C.pcReduce(C.pcInitial(plan()), {type: 'edit'}), {type: 'view', view: plan()});
  assert.equal(same.mode, 'edit', 'the same version keeps the edit open');
});

test('refusals: stale and wrong gate redraw the current view, a running turn and a hard cap say why', () => {
  const v4 = plan({version: 4});
  assert.deepEqual(C.pcOutcome({supported: true, ok: true, view: closed(), continueMessage: 'Go on.'}), {view: closed(), continueMessage: 'Go on.'});
  assert.equal(C.pcOutcome({supported: true, ok: true, view: v4, continueMessage: null}).continueMessage, null);
  const stale = C.pcOutcome({supported: true, ok: false, status: 409, code: 'stale-version', error: 'stale', view: v4});
  assert.equal(stale.view, v4); assert.match(stale.notice, /changed/); assert.equal(stale.error, undefined);
  assert.match(C.pcOutcome({ok: false, status: 409, code: 'wrong-gate', view: v4}).notice, /changed/);
  assert.match(C.pcOutcome({ok: false, status: 409, code: 'turn-running', view: v4}).error, /turn is running/);
  assert.equal(C.pcOutcome({ok: false, status: 422, code: 'over-cap', error: 'over the turn budget', view: v4}).error, 'over the turn budget');
  assert.deepEqual(C.pcOutcome({ok: false, status: 404, code: null, error: 'no project', view: null}), {closed: true, notice: 'This chat has no project any more.'});
  assert.equal(C.pcOutcome({ok: false, status: 400, code: null, error: 'verdict must be', view: null}).error, 'verdict must be');
  assert.match(C.pcOutcome({supported: false}).error, /update it/);
});

/* ---------------- DOM ---------------- */

/** Just enough DOM to build the card in Node: no innerHTML anywhere. */
function fakeDoc() {
  const all = [];
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this._text = ''; this.className = ''; this.hidden = false; this.disabled = false; all.push(this); }
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; }
    get firstChild() { return this.children[0] || null; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set innerHTML(_v) { throw new Error('innerHTML used'); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    fire(type) { for (const fn of this.listeners[type] || []) fn({target: this}); }
    findAll(pred) { const out = []; const walk = (e) => { if (pred(e)) out.push(e); e.children.forEach(walk); }; walk(this); return out; }
  }
  return {createElement: (t) => new El(t), all};
}

test('the card is built from text nodes and listeners; model text is never markup', () => {
  const doc = fakeDoc();
  const host = doc.createElement('div');
  const evil = plan({brief: Object.assign(plan().brief, {what: '<img src=x onerror=alert(1)>'}),
    plan: Object.assign(plan().plan, {rows: [row({title: '<b>bold</b>', reason: '<script>x</script>'})]})});
  const acts = [];
  C.pcDraw(doc, host, C.pcModel(C.pcInitial(evil)), (a) => acts.push(a));
  assert.equal(host.hidden, false);
  assert.ok(host.textContent.includes('<img src=x onerror=alert(1)>'), 'shown as text');
  assert.ok(host.textContent.includes('<b>bold</b>'));
  assert.ok(host.textContent.includes(C.PC_WRITE_SCOPE_NOTE));
  assert.ok(!doc.all.some((e) => Object.keys(e.attrs).some((k) => k.startsWith('on'))), 'no inline handlers');
  const buttons = host.findAll((e) => e.tagName === 'BUTTON');
  assert.deepEqual(buttons.map((b) => b.textContent), ['Hide', 'Approve', 'Edit rows…', 'Cheaper', 'Better quality', 'Cancel project']);
  buttons.find((b) => b.textContent === 'Cheaper').fire('click');
  buttons.find((b) => b.textContent === 'Edit rows…').fire('click');
  assert.deepEqual(acts, [{type: 'verdict', verdict: 'cheaper'}, {type: 'edit'}]);
  // Nothing to decide empties and hides the host.
  C.pcDraw(doc, host, null, () => {});
  assert.equal(host.hidden, true);
  assert.equal(host.children.length, 0);
});

test('edit mode draws a worker and a reviewer select per row, offering only the row\'s options', () => {
  const doc = fakeDoc();
  const host = doc.createElement('div');
  const acts = [];
  C.pcDraw(doc, host, C.pcModel(C.pcReduce(C.pcInitial(plan()), {type: 'edit'})), (a) => acts.push(a));
  const selects = host.findAll((e) => e.tagName === 'SELECT');
  assert.equal(selects.length, 4);
  assert.deepEqual(selects[0].children.map((o) => o.textContent), ['openrouter:w-a', 'openrouter:w-b']);
  assert.deepEqual(selects[1].children.map((o) => o.textContent), ['openrouter:r-a', 'openrouter:r-b', 'no review']);
  selects[1].value = '2'; selects[1].fire('change');
  assert.deepEqual(acts, [{type: 'reviewer', taskId: 't1', value: null}]);
  const hard = host.findAll((e) => e.tagName === 'BUTTON').map((b) => [b.textContent, b.disabled]);
  assert.deepEqual(hard, [['Hide', false], ['Re-estimate', true], ['Back', false]]);
});

test('a hard violation is drawn as such', () => {
  const doc = fakeDoc();
  const host = doc.createElement('div');
  C.pcDraw(doc, host, C.pcModel(C.pcInitial(plan({violations: [{kind: 'daily-limit', severity: 'hard', message: 'over today'}]}))), () => {});
  const li = host.findAll((e) => e.className === 'pc-hard');
  assert.equal(li.length, 1);
  assert.equal(li[0].textContent, '✕ Over a hard limit: over today');
  assert.equal(host.findAll((e) => e.tagName === 'BUTTON' && e.textContent === 'Approve')[0].disabled, true);
});

test('the correction box keeps maxLength 2000 and its counter follows the text', () => {
  const doc = fakeDoc();
  const host = doc.createElement('div');
  const acts = [];
  C.pcDraw(doc, host, C.pcModel(C.pcReduce(C.pcInitial(milestone()), {type: 'correct'})), (a) => acts.push(a));
  const [ta] = host.findAll((e) => e.tagName === 'TEXTAREA');
  assert.equal(ta.maxLength, 2000);
  ta.value = 'Bigger';
  ta.fire('input');
  assert.deepEqual(acts, [{type: 'note', note: 'Bigger'}]);
  assert.equal(host.findAll((e) => e.className === 'pc-count')[0].textContent, '6 / 2000');
});

/* ---------------- the controller ---------------- */

function controller({decide, read} = {}) {
  const drawn = [], continued = [], reads = [];
  let accept = true;
  const card = C.createProjectCard({
    api: {
      read: async (sid) => { reads.push(sid); return read ? read(sid) : {supported: true, ok: true, view: null}; },
      decide: async (body) => decide(body),
    },
    draw: (model, on) => drawn.push({model, on}),
    onContinue: (sid, text) => { if (!accept) return false; continued.push([sid, text]); return true; },
  });
  return {card, drawn, continued, reads, last: () => drawn.at(-1), refuse: (v) => { accept = !v; }};
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('the controller draws the chat on screen, newest version, and reads the view when the chat opens', async () => {
  const c = controller({read: async () => ({supported: true, ok: true, view: plan({version: 3})})});
  c.card.onFrame({sessionId: 'ses-1', view: plan({version: 2})});
  assert.equal(c.drawn.length, 0, 'another chat is not drawn');
  c.card.follow('ses-1');
  assert.equal(c.last().model.version, 2, 'drawn at once from what came');
  await tick();
  assert.deepEqual(c.reads, ['ses-1']);
  assert.equal(c.last().model.version, 3, 'the read was newer');
  c.card.onFrame({sessionId: 'ses-1', view: plan({version: 2})});
  assert.equal(c.last().model.version, 3, 'an older frame is not drawn');
  c.card.onFrame({sessionId: 'other', view: plan({version: 9})});
  assert.equal(c.last().model.version, 3);
  c.card.follow('ses-1');
  assert.deepEqual(c.reads, ['ses-1'], 'the same chat is not read again');
  c.card.follow(null);
  assert.equal(c.last().model, null);
});

test('approve sends gate and version from the view, and continue_message becomes the next message', async () => {
  const sent = [];
  const c = controller({decide: async (body) => { sent.push(body); return {supported: true, ok: true, view: closed(), continueMessage: 'I approved. Continue with milestone "Base".'}; }});
  c.card.onFrame({sessionId: 'ses-1', view: plan()});
  c.card.follow('ses-1');
  c.last().on({type: 'verdict', verdict: 'approve'});
  assert.equal(c.last().model.busy, true);
  await tick(); await tick();
  assert.deepEqual(sent, [{session: 'ses-1', gate: {kind: 'plan'}, version: 3, verdict: 'approve'}]);
  assert.deepEqual(c.continued, [['ses-1', 'I approved. Continue with milestone "Base".']]);
  assert.equal(c.last().model, null, 'the gate closed');
});

test('a continue_message for a chat left meanwhile waits until that chat is on screen again', async () => {
  let release;
  const c = controller({decide: () => new Promise((r) => { release = r; })});
  c.card.onFrame({sessionId: 'ses-1', view: plan()});
  c.card.follow('ses-1');
  c.last().on({type: 'verdict', verdict: 'approve'});
  await tick();
  c.card.follow('ses-2');
  release({supported: true, ok: true, view: closed(), continueMessage: 'Go on.'});
  await tick(); await tick();
  assert.deepEqual(c.continued, []);
  c.card.follow('ses-1');
  assert.deepEqual(c.continued, [['ses-1', 'Go on.']]);
  // A send the window refused (a turn running) is tried again on the next follow.
  const d = controller({decide: async () => ({supported: true, ok: true, view: closed(), continueMessage: 'Again.'})});
  d.refuse(true);
  d.card.onFrame({sessionId: 'ses-1', view: plan()}); d.card.follow('ses-1');
  d.last().on({type: 'verdict', verdict: 'approve'}); await tick(); await tick();
  assert.deepEqual(d.continued, []);
  d.refuse(false); d.card.follow('ses-1');
  assert.deepEqual(d.continued, [['ses-1', 'Again.']]);
});

test('a stale-version refusal redraws the current view with a notice, a running turn keeps the card with the reason', async () => {
  const answers = [
    {supported: true, ok: false, status: 409, code: 'stale-version', error: 'stale', view: plan({version: 4})},
    {supported: true, ok: false, status: 409, code: 'turn-running', error: 'running', view: plan({version: 4})},
  ];
  const c = controller({decide: async () => answers.shift()});
  c.card.onFrame({sessionId: 'ses-1', view: plan()}); c.card.follow('ses-1');
  c.last().on({type: 'verdict', verdict: 'approve'}); await tick(); await tick();
  assert.equal(c.last().model.version, 4);
  assert.match(c.last().model.notice, /changed/);
  assert.equal(c.last().model.busy, false);
  c.last().on({type: 'verdict', verdict: 'approve'}); await tick(); await tick();
  assert.match(c.last().model.error, /turn is running/);
  assert.deepEqual(c.continued, []);
});

test('the edit flow end to end: pick, re-estimate, the new version comes back as a fresh card', async () => {
  const sent = [];
  const c = controller({decide: async (body) => { sent.push(body); return {supported: true, ok: true, view: plan({version: 4}), continueMessage: null}; }});
  c.card.onFrame({sessionId: 'ses-1', view: plan()}); c.card.follow('ses-1');
  c.last().on({type: 'edit'});
  c.last().on({type: 'worker', taskId: 't2', value: 'openrouter:w-b'});
  assert.equal(c.last().model.changedRows, 1);
  c.last().on({type: 'verdict', verdict: 'edit'}); await tick(); await tick();
  assert.deepEqual(sent[0].edits, {rows: [{taskId: 't2', worker: 'openrouter:w-b'}]});
  assert.equal(c.last().model.version, 4);
  assert.equal(c.last().model.mode, 'view');
  assert.deepEqual(c.continued, [], 'an edit re-estimates; nothing runs');
});

test('Hide puts the card away for that version only', () => {
  const c = controller();
  c.card.onFrame({sessionId: 'ses-1', view: plan()}); c.card.follow('ses-1');
  c.last().on({type: 'hide'});
  assert.equal(c.last().model, null);
  c.card.onFrame({sessionId: 'ses-1', view: plan({version: 4})});
  assert.equal(c.last().model.version, 4);
});

test('index.html loads project-card.js before renderer.js, and the page draws it into its own layer', () => {
  const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  assert.ok(index.indexOf('project-card.js') > 0 && index.indexOf('project-card.js') < index.indexOf('renderer.js'));
  // A column of its own in #main, after the chat, not a layer over it.
  assert.match(index, /<section id="content"><\/section>\s*<!--[^>]*-->\s*<aside id="projectcard" hidden><\/aside>/);
  assert.match(index, /project-card\.css/);
  const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(renderer, /BR\.onProject\(/);
  assert.match(renderer, /createProjectCard\(/);
});

test('only the body scrolls: the head and the action bar are the card\'s own children, the bar last', () => {
  const doc = fakeDoc();
  const host = doc.createElement('div');
  for (const model of [C.pcModel(C.pcInitial(plan())), C.pcModel(C.pcReduce(C.pcInitial(milestone()), {type: 'correct'}))]) {
    C.pcDraw(doc, host, model, () => {});
    const card = host.children[0];
    assert.deepEqual(card.children.map((c) => c.className), ['pc-head', 'pc-body', 'pc-actions']);
    const [, body, bar] = card.children;
    assert.equal(body.findAll((e) => e.tagName === 'BUTTON').length, 0, 'no button scrolls away with the body');
    assert.ok(bar.children.length >= 2);
  }
  const css = readFileSync(new URL('../renderer/css/project-card.css', import.meta.url), 'utf8');
  assert.match(css, /\.pc-body\{[^}]*flex:1;[^}]*overflow-y:auto/);
  assert.match(css, /\.pc-actions\{[^}]*flex:none/);
});

test('a member ref keeps provider and model whole, breaks only after the colon, and carries the full ref as its title', () => {
  const doc = fakeDoc();
  const ref = C.pcRef(doc, 'openrouter:reviewer-quick');
  assert.equal(ref.title, 'openrouter:reviewer-quick');
  assert.deepEqual(ref.children.map((c) => [c.tagName, c.textContent]), [['SPAN', 'openrouter:'], ['WBR', ''], ['SPAN', 'reviewer-quick']]);
  assert.deepEqual(C.pcRef(doc, 'plain').children.map((c) => c.textContent), ['plain']);
  const host = doc.createElement('div');
  C.pcDraw(doc, host, C.pcModel(C.pcInitial(plan())), () => {});
  assert.ok(host.textContent.includes('worker openrouter:w-a · review openrouter:r-a'));
  assert.ok(host.textContent.includes('review none'));
});

test('a narrow window puts the card between the chat\'s top and the composer\'s top; a wide one leaves it to the column', () => {
  const vars = {}, classes = new Set();
  const host = {hidden: false, classList: {toggle: (c, on) => (on ? classes.add(c) : classes.delete(c))}, style: {setProperty: (k, v) => { vars[k] = v; }}};
  const rect = (r) => ({getBoundingClientRect: () => r});
  const win = (w) => ({innerWidth: w, document: {querySelector: (q) => (q === '#content' ? rect({left: 60, top: 52, width: 700, bottom: 900})
    : q === '.composerwrap' ? rect({top: 760}) : null)}});
  C.pcPlace(win(1400), host);
  assert.equal(classes.has('pc-narrow'), false);
  assert.deepEqual(vars, {});
  C.pcPlace(win(C.PC_NARROW_PX - 1), host);
  assert.equal(classes.has('pc-narrow'), true);
  assert.deepEqual(vars, {'--pc-left': '68px', '--pc-width': '684px', '--pc-top': '60px', '--pc-height': '692px'});
  assert.ok(52 + 8 + 692 <= 760, 'the sheet ends above the composer');
});
