// Issue #39: the fusion project card (renderer/project-card.js): the newest
// view per chat, the edit reducer, the decision body, refusals, the lines it
// draws and the DOM it builds (textContent only), and the controller that
// sends continue_message as the chat's next message.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadCore } from './core-ts.mjs';

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
  const marks = core.match(/const FACT_MARK[^=]*= \{([^}]*)\}/)[1];
  assert.deepEqual(Object.fromEntries([...marks.matchAll(/(\w+): "([^"]*)"/g)].map((x) => [x[1], x[2]])), C.PC_FACT_MARK, 'criterion fact marks');
  const parse = readFileSync(new URL('../../src/session/project-decision-parse.ts', import.meta.url), 'utf8');
  assert.equal(C.PC_NOTE_MAX, Number(parse.match(/MAX_PROJECT_NOTE_CHARS = (\d+)/)[1]));
});

/* ---------------- newest version only ---------------- */

test('the store takes views in arrival order; versions are per gate, not a project-wide clock', () => {
  const st = C.pcStore();
  assert.equal(st.put('ses-1', plan({version: 3})), true);
  assert.equal(st.put('ses-1', plan({version: 3})), false, 'the same view again changes nothing');
  assert.equal(st.put('ses-1', plan({version: 2})), true, 'the agent said so last: no cross-version guessing');
  assert.equal(st.get('ses-1').version, 2);
  assert.equal(st.put('ses-1', closed(2)), true, 'the gate closed');
  assert.equal(st.get('ses-1'), null);
  assert.equal(st.put('ses-1', plan({version: 1})), true, 'a new gate at a lower number opens');
  assert.equal(st.put('ses-1', milestone({version: 1})), true);
  assert.equal(st.put('other', plan({schema: 2})), false);
  assert.equal(st.put('', plan()), false);
  assert.equal(st.put('ses-1', plan({version: 6, cancelled: true, allowedVerdicts: []})), true, 'a cancelled project closes the card');
  assert.equal(st.get('ses-1'), null);
});

/* ---------------- what the card shows ---------------- */

test('the plan card: rows with worker, reviewer, reason, basis and estimate, totals, the write-scope note, milestones', () => {
  const m = C.pcModel(C.pcInitial(plan()));
  assert.equal(m.headline, 'The Fusion project plan waits for your approval');
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
  assert.deepEqual(m.actions.map((a) => a.label), ['Approve', 'Cancel Fusion project']);
  assert.equal(C.pcModel(C.pcInitial(closed())), null, 'nothing to decide, no card');
  const b = C.pcModel(C.pcInitial(brief()));
  assert.deepEqual(b.actions.map((a) => a.label), ['Approve', 'Revise in chat', 'Cancel Fusion project']);
  const ms = C.pcModel(C.pcInitial(milestone()));
  assert.deepEqual(ms.actions.map((a) => a.label), ['Approve milestone', 'Correct…', 'Cancel Fusion project']);
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
  assert.deepEqual(C.pcOutcome({ok: false, status: 404, code: null, error: 'no project', view: null}), {closed: true, notice: 'This chat has no Fusion project any more.'});
  assert.equal(C.pcOutcome({ok: false, status: 400, code: null, error: 'verdict must be', view: null}).error, 'verdict must be');
  assert.match(C.pcOutcome({supported: false}).error, /update it/);
});

/* ---------------- DOM ---------------- */

/** Just enough DOM to build the card in Node: no innerHTML anywhere. */
function fakeDoc() {
  const all = [];
  const doc = {activeElement: null};
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this._text = ''; this.className = ''; this.hidden = false; this.disabled = false; all.push(this); }
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; }
    get firstChild() { return this.children[0] || null; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set innerHTML(_v) { throw new Error('innerHTML used'); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    focus() { doc.activeElement = this; }
    contains(x) { for (let n = x; n; n = n.parentNode) if (n === this) return true; return false; }
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    fire(type) { for (const fn of this.listeners[type] || []) fn({target: this}); }
    findAll(pred) { const out = []; const walk = (e) => { if (pred(e)) out.push(e); e.children.forEach(walk); }; walk(this); return out; }
  }
  return Object.assign(doc, {createElement: (t) => new El(t), all});
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
  assert.deepEqual(buttons.map((b) => b.textContent), ['Hide', 'Approve', 'Edit rows…', 'Cheaper', 'Better quality', 'Cancel Fusion project']);
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

function controller({decide, read, extra} = {}) {
  const drawn = [], continued = [], reads = [], changes = [];
  let accept = true;
  const card = C.createProjectCard({
    ...extra,
    onChange: () => changes.push(1),
    api: {
      read: async (sid) => { reads.push(sid); return read ? read(sid) : {supported: true, ok: true, view: null}; },
      decide: async (body) => decide(body),
    },
    draw: (model, on) => drawn.push({model, on}),
    onContinue: (sid, text) => { if (!accept) return false; continued.push([sid, text]); return true; },
  });
  return {card, drawn, continued, reads, changes, last: () => drawn.at(-1), refuse: (v) => { accept = !v; }};
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
  assert.equal(c.last().model.version, 2, 'a frame after the read is what the agent says now');
  c.card.onFrame({sessionId: 'other', view: plan({version: 9})});
  assert.equal(c.last().model.version, 2, 'another chat\'s frame is not drawn here');
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

/* ---------------- the agent's own gate sequence ---------------- */

const CORE = loadCore(new URL('../../src/session/session-project.ts', import.meta.url));

/** The views a real project goes through (session-project.ts), shaped as projectGateView shapes them. */
function coreSequence() {
  let now = 1000, p;
  const views = [];
  const take = (r) => { assert.ok(r.ok, JSON.stringify(r.error)); p = r.project; views.push(coreView(p)); };
  const at = () => ({gate: p.gate, version: CORE.gateVersion(p)});
  const row = (taskId, milestoneId) => ({taskId, title: 'Task ' + taskId, milestoneId, worker: 'openrouter:w-a', reviewer: null,
    reason: 'preset', basis: 'preset', samples: 0, estCostUsd: 0.1, estMs: 1000});
  take(CORE.applyProjectUpdate(undefined, {kind: 'brief', brief: {what: 'A chess game', users: 'two players', how: 'a web page', successCriteria: ['legal moves']}, draftedAfterUntrusted: false}, now++));
  take(CORE.applyProjectDecision(p, {...at(), verdict: 'approve'}, {now: now++}));
  take(CORE.applyProjectUpdate(p, {kind: 'plan', milestones: [{id: 'm1', title: 'Base', kind: 'base'}, {id: 'm2', title: 'Logic', kind: 'logic'}],
    rows: [row('t1', 'm1'), row('t2', 'm2')], detail: 'full'}, now++));
  take(CORE.applyProjectDecision(p, {...at(), verdict: 'approve'}, {now: now++}));
  take(CORE.applyProjectUpdate(p, {kind: 'milestone', id: 'm1', state: 'done', summary: 'The board renders.'}, now++));
  take(CORE.applyProjectDecision(p, {...at(), verdict: 'edit', edits: {note: 'Bigger squares'}}, {now: now++}));
  take(CORE.applyProjectUpdate(p, {kind: 'milestone', id: 'm1', state: 'done', summary: 'The board renders bigger.'}, now++));
  return views;
}
function coreView(p) {
  return {
    schema: 1, sessionId: 'ses-1', gate: p.gate, version: CORE.gateVersion(p),
    allowedVerdicts: p.cancelledAt !== undefined ? [] : CORE.allowedProjectVerdicts(p.gate),
    expectation: CORE.projectExpectation(p), cancelled: p.cancelledAt !== undefined, brief: p.brief ?? null,
    plan: p.plan ? {status: p.plan.status, detail: p.plan.detail, version: p.plan.version, draftedAfterUntrusted: p.plan.draftedAfterUntrusted,
      rows: p.plan.rows.map((r) => ({...r, selectableWorkers: ['openrouter:w-a'], selectableReviewers: []})), totals: p.plan.totals} : null,
    milestones: p.milestones.map((m) => ({...m, estCostUsd: null, estMs: null})), violations: [],
  };
}

test('the agent\'s real sequence brief → none → plan → none → milestone → none → milestone draws every gate', () => {
  const views = coreSequence();
  assert.deepEqual(views.map((v) => v.gate.kind + ' v' + v.version),
    ['brief v1', 'none v1', 'plan v1', 'none v1', 'milestone v2', 'none v2', 'milestone v3']);
  const c = controller();
  c.card.follow('ses-1');
  const drawn = [];
  for (const view of views) {
    c.card.onFrame({sessionId: 'ses-1', view});
    drawn.push(c.last().model ? c.last().model.gate + ' v' + c.last().model.version : null);
  }
  assert.deepEqual(drawn, ['brief v1', null, 'plan v1', null, 'milestone v2', null, 'milestone v3']);
});

test('a GET /api/project answer sent before a frame arrived does not overwrite that frame', async () => {
  const views = coreSequence();
  let answer;
  const c = controller({read: () => new Promise((r) => { answer = r; })});
  c.card.follow('ses-1');
  await tick();
  c.card.onFrame({sessionId: 'ses-1', view: views[2]});   // the plan, after the read went out
  answer({supported: true, ok: true, view: views[0]});      // the read saw the brief
  await tick(); await tick();
  assert.equal(c.last().model.gate, 'plan');
});

test('Hide is keyed on the gate, not only its number: another gate at the same version shows', () => {
  const c = controller();
  c.card.onFrame({sessionId: 'ses-1', view: plan({version: 1})}); c.card.follow('ses-1');
  c.last().on({type: 'hide'});
  assert.equal(c.last().model, null);
  c.card.onFrame({sessionId: 'ses-1', view: milestone({version: 1})});
  assert.equal(c.last().model.gate, 'milestone', 'the milestone gate at v1 is not the plan the person hid');
});

test('Hide is undone by leaving the chat, and by Show Fusion project while the gate is open', () => {
  const c = controller();
  c.card.onFrame({sessionId: 'ses-1', view: plan()}); c.card.follow('ses-1');
  assert.equal(c.card.hiddenOpen(), false);
  c.last().on({type: 'hide'});
  assert.equal(c.card.hiddenOpen(), true, 'the header offers Show Fusion project');
  assert.ok(c.changes.length > 0, 'the page is told, so it redraws the header');
  c.card.show();
  assert.equal(c.last().model.version, 3);
  assert.equal(c.card.hiddenOpen(), false);
  c.last().on({type: 'hide'});
  c.card.follow('ses-2'); c.card.follow('ses-1');
  assert.equal(c.last().model.version, 3, 'opening the chat again shows the card');
});

test('the page draws Show Fusion project in the chat header and acts on it', () => {
  const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(renderer, /PCARD\.hiddenOpen\(\)[^\n]*data-act="project:show"/);
  assert.match(renderer, /a === 'project:show'[^\n]*PCARD\.show\(\)/);
});

/* ---------------- the continue message and submit()'s holds ---------------- */

/** renderer.js's projectCardContinue, run against stand-ins for the page's state. */
function continueWith(over = {}) {
  const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  const fn = src.match(/function projectCardContinue\([\s\S]*?\n}\n/)[0];
  const calls = {submit: [], voiceStop: 0};
  const env = Object.assign({
    S: {agentSession: 'ses-1', room: 'chat', busy: false, pending: null, live: {state: 'connected'}, draft: ''},
    VOICE: {state: 'idle'}, BSW: {gating: false},
    starterHoldsSend: () => false, fitHoldsSend: () => false, openHoldsComposer: () => false, localTurnGate: () => ({kind: 'run'}),
  }, over);
  const submit = (text, opts) => {
    // submit()'s own first steps: dictation is stopped, a hold keeps the message out.
    if (env.VOICE.state === 'recording' || env.VOICE.state === 'starting') { calls.voiceStop++; return false; }
    if (env.VOICE.state === 'finishing' || env.starterHoldsSend() || env.fitHoldsSend() || env.BSW.gating) return false;
    calls.submit.push([text, opts]);
    return env.submitRefuses ? false : true;
  };
  const run = new Function('S', 'VOICE', 'BSW', 'starterHoldsSend', 'fitHoldsSend', 'openHoldsComposer', 'localTurnGate', 'swxWaitsForRoute', 'DRAIN_OWED', 'SWX', 'submit', '$', 'autosize', 'pcCanContinue',
    fn + '\nreturn projectCardContinue;')(env.S, env.VOICE, env.BSW, env.starterHoldsSend, env.fitHoldsSend, env.openHoldsComposer, env.localTurnGate, () => false, false, {sendError: null}, submit, () => null, () => {}, C.pcCanContinue);
  return {sent: run('ses-1', 'Go on.'), calls};
}

test('a continue message is not handed to submit() while it would not send, and dictation is left alone', () => {
  for (const [label, over] of [
    ['dictation recording', {VOICE: {state: 'recording'}}],
    ['dictation starting', {VOICE: {state: 'starting'}}],
    ['dictation finishing', {VOICE: {state: 'finishing'}}],
    ['the starter model downloading', {starterHoldsSend: () => true}],
    ['a backend switch gating', {BSW: {gating: true}}],
    ['a model test holding the local server', {fitHoldsSend: () => true}],
    ['the local model not on disk', {localTurnGate: () => ({kind: 'block', text: 'x'})}],
    ['a turn running', {S: {agentSession: 'ses-1', room: 'chat', busy: true, live: {state: 'connected'}, draft: ''}}],
    ['another room on screen (Studio)', {S: {agentSession: 'ses-1', room: 'studio', busy: false, live: {state: 'connected'}, draft: ''}}],
  ]) {
    const r = continueWith(over);
    assert.equal(r.sent, false, label + ': kept pending');
    assert.equal(r.calls.voiceStop, 0, label + ': the recording is not stopped');
    assert.deepEqual(r.calls.submit, [], label);
  }
  const ok = continueWith();
  assert.equal(ok.sent, true);
  assert.deepEqual(ok.calls.submit, [['Go on.', {plain: true}]]);
});

test('a continue message submit() did not send stays pending: the card is told false', () => {
  const r = continueWith({submitRefuses: true});
  assert.deepEqual(r.calls.submit, [['Go on.', {plain: true}]]);
  assert.equal(r.sent, false, 'submit() answered false: the continue stays pending');
});

test('submit() answers whether it took the message: no bare return, every caller may ignore it', () => {
  const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  const fn = src.match(/\nfunction submit\(preparedSkillText, opts\) \{[\s\S]*?\n}\n/)[0];
  // The local gate's snapshot callback returns from itself, not from submit().
  const own = fn.replace(/bswSnapshot\(\)\.then\(\(\) => \{[\s\S]*?\n    \}\);/, '');
  assert.notEqual(own, fn, 'the gate callback is found');
  assert.deepEqual(own.match(/return\s*;/g) || [], [], 'every return says true or false');
  assert.match(fn, /fitHoldsSend\(\)\) \{[^\n]*return false; \}/, 'a model test holding the server: not sent');
  assert.match(fn, /bswGatedTurn\(text\);\n  return true;\n}\n$/, 'a turn started: sent');
});

test('pcCanContinue waits while a model test holds the local server', () => {
  const env = {onScreen: true, room: 'chat', busy: false, pending: null, connected: true, opening: false, voice: 'idle', starterHolds: false, gating: false, fitHolds: false};
  assert.equal(C.pcCanContinue(env), true);
  assert.equal(C.pcCanContinue({...env, fitHolds: true}), false);
});

/* ---------------- focus and announcements ---------------- */

const byFocus = (host, key) => host.findAll((e) => e.getAttribute && e.getAttribute('data-pc-focus') === key)[0];

test('a repaint keeps the focus on the same control: a button, a row\'s select', () => {
  const doc = fakeDoc();
  const host = doc.createElement('div');
  const draw = (state) => C.pcDraw(doc, host, C.pcModel(state), () => {});
  draw(C.pcInitial(plan()));
  byFocus(host, 'verdict:cheaper').focus();
  const before = doc.activeElement;
  draw(C.pcInitial(plan()));
  assert.notEqual(doc.activeElement, before, 'a new node');
  assert.equal(doc.activeElement.getAttribute('data-pc-focus'), 'verdict:cheaper');
  assert.equal(doc.activeElement.textContent, 'Cheaper');
  const edit = C.pcReduce(C.pcInitial(plan()), {type: 'edit'});
  draw(edit);
  byFocus(host, 'worker:t2').focus();
  draw(C.pcReduce(edit, {type: 'worker', taskId: 't2', worker: 'openrouter:w-b'}));
  assert.equal(doc.activeElement.getAttribute('data-pc-focus'), 'worker:t2');
  assert.ok(host.contains(doc.activeElement));
});

test('the correction box being typed in is not replaced by a repaint: same node, text and caret', () => {
  const doc = fakeDoc();
  const host = doc.createElement('div');
  const state = C.pcReduce(C.pcInitial(milestone()), {type: 'correct'});
  C.pcDraw(doc, host, C.pcModel(state), () => {});
  const ta = byFocus(host, 'note');
  ta.focus(); ta.value = 'Bigger squ'; ta.setSelectionRange(4, 4);
  // A frame repaints before the input event reached the state.
  C.pcDraw(doc, host, C.pcModel(state), () => {});
  const now = byFocus(host, 'note');
  assert.equal(now, ta, 'the same textarea');
  assert.equal(now.value, 'Bigger squ');
  assert.equal(doc.activeElement, ta);
  assert.deepEqual([now.selectionStart, now.selectionEnd], [4, 4]);
  assert.equal(host.findAll((e) => e.className === 'pc-count')[0].textContent, '10 / 2000');
});

test('notices and errors are announced', () => {
  const doc = fakeDoc();
  const host = doc.createElement('div');
  let s = C.pcReduce(C.pcInitial(plan()), {type: 'notice', notice: 'The project changed.'});
  C.pcDraw(doc, host, C.pcModel(s), () => {});
  const notice = host.findAll((e) => e.className === 'pc-notice')[0];
  assert.equal(notice.attrs.role, 'status');
  assert.equal(notice.attrs['aria-live'], 'polite');
  s = C.pcReduce(s, {type: 'failed', error: 'A turn is running.'});
  C.pcDraw(doc, host, C.pcModel(s), () => {});
  assert.equal(host.findAll((e) => e.className === 'pc-error')[0].attrs.role, 'alert');
});

test('the frame of my own edit arriving before its HTTP answer is not "your changes were set aside"', async () => {
  let release;
  const c = controller({decide: () => new Promise((r) => { release = r; }), read: async () => ({supported: true, ok: true, view: plan()})});
  c.card.onFrame({sessionId: 'ses-1', view: plan()}); c.card.follow('ses-1');
  c.last().on({type: 'edit'});
  c.last().on({type: 'worker', taskId: 't2', value: 'openrouter:w-b'});
  c.last().on({type: 'verdict', verdict: 'edit'});
  await tick();
  c.card.onFrame({sessionId: 'ses-1', view: plan({version: 4})});   // the agent's event, first
  assert.equal(c.last().model.version, 4);
  assert.equal(c.last().model.busy, true, 'still in flight');
  assert.equal(c.last().model.notice, null, 'no false "set aside"');
  release({supported: true, ok: true, view: plan({version: 4}), continueMessage: null});
  await tick(); await tick();
  assert.equal(c.last().model.busy, false);
  assert.equal(c.last().model.notice, null);
  assert.equal(c.last().model.mode, 'view');
});

test('Cancel Fusion project asks twice: the button turns into Confirm cancel for a few seconds, keeping its focus', async () => {
  const sent = [];
  const c = controller({decide: async (body) => { sent.push(body); return {supported: true, ok: true, view: closed(), continueMessage: null}; },
    read: async () => ({supported: true, ok: true, view: plan()}), extra: {confirmMs: 40}});
  c.card.onFrame({sessionId: 'ses-1', view: plan()}); c.card.follow('ses-1');
  const label = () => c.last().model.actions.find((a) => a.verdict === 'cancel').label;
  assert.equal(label(), 'Cancel Fusion project');
  c.last().on({type: 'verdict', verdict: 'cancel'});
  await tick();
  assert.deepEqual(sent, [], 'the first press sends nothing');
  assert.equal(label(), 'Confirm cancel');
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(label(), 'Cancel Fusion project', 'the confirmation lapses');
  c.last().on({type: 'verdict', verdict: 'cancel'});
  c.last().on({type: 'verdict', verdict: 'cancel'});
  await tick(); await tick();
  assert.deepEqual(sent.map((b) => b.verdict), ['cancel']);
  // The confirm button is the same control for the focus (keyboard: Enter, Enter).
  const doc = fakeDoc();
  const host = doc.createElement('div');
  const armed = C.pcReduce(C.pcInitial(plan()), {type: 'armCancel'});
  C.pcDraw(doc, host, C.pcModel(armed), () => {});
  const b = byFocus(host, 'verdict:cancel');
  assert.equal(b.textContent, 'Confirm cancel');
  assert.equal(b.tagName, 'BUTTON');
});

test('the narrow sheet follows the composer and the chat through a ResizeObserver, not a layout read per paint', () => {
  const observed = [];
  let fire = null;
  class RO { constructor(cb) { fire = cb; } observe(el) { observed.push(['+', el.id])} unobserve(el) { observed.push(['-', el.id]); } }
  let composerTop = 760;
  const content = {id: 'content', getBoundingClientRect: () => ({left: 60, top: 52, width: 700, bottom: 900})};
  let composer = {id: 'composer-1', getBoundingClientRect: () => ({top: composerTop})};
  const vars = {};
  const host = {hidden: false, classList: {toggle() {}}, style: {setProperty: (k, v) => { vars[k] = v; }}};
  const win = {innerWidth: 800, ResizeObserver: RO,
    document: {querySelector: (q) => (q === '#content' ? content : q === '.composerwrap' ? composer : null)}};
  const watch = C.pcWatch(win, host);
  watch.sync();
  assert.deepEqual(observed, [['+', 'content'], ['+', 'composer-1']]);
  watch.sync();
  assert.equal(observed.length, 2, 'the same nodes are not observed again');
  composerTop = 700;   // the person typed a second line
  fire([]);
  assert.equal(vars['--pc-height'], '632px', 'the sheet ends above the taller composer');
  composer = {id: 'composer-2', getBoundingClientRect: () => ({top: composerTop})};   // a paint replaced it
  watch.sync();
  assert.deepEqual(observed.slice(2), [['-', 'composer-1'], ['+', 'composer-2']]);
  const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  const follow = renderer.match(/function projectCardFollow\(\)[\s\S]*?\n}\n/)[0];
  assert.ok(!/pcPlace\(/.test(follow), 'no forced layout on every paint');
  assert.match(follow, /PCWATCH\.sync\(\)/);
});

test('a continue message still pending survives reset() for the same chat (the agent restarted)', async () => {
  const c = controller({decide: async () => ({supported: true, ok: true, view: closed(), continueMessage: 'Go on.'})});
  c.refuse(true);
  c.card.onFrame({sessionId: 'ses-1', view: plan()}); c.card.follow('ses-1');
  c.last().on({type: 'verdict', verdict: 'approve'}); await tick(); await tick();
  assert.deepEqual(c.continued, []);
  c.card.reset();
  c.refuse(false);
  c.card.follow('ses-1');
  assert.deepEqual(c.continued, [['ses-1', 'Go on.']]);
});

/* ---------------- gate-view fields the core added (issues #40, #54) ---------------- */

test('a local row is priced "$0.00 (local)", as the TUI card says', () => {
  const view = plan({plan: Object.assign(plan().plan, {rows: [row({local: true, estCostUsd: 0}), row({taskId: 't2', estCostUsd: 0})]})});
  const m = C.pcModel(C.pcInitial(view));
  assert.deepEqual(m.rows.map((r) => r.estimate), ['$0.00 (local) · ~1m35s', '$0.00 · ~1m35s']);
  const doc = fakeDoc();
  const host = doc.createElement('div');
  C.pcDraw(doc, host, m, () => {});
  assert.ok(host.textContent.includes('$0.00 (local) · ~1m35s'));
});

test('the view\'s hints are shown; Edit rows is hidden when the plan offers no choice', () => {
  const hint = 'only one worker available: configure llm.runMode.fusion.team to choose';
  const view = plan({hints: [hint], plan: Object.assign(plan().plan, {editable: false})});
  const m = C.pcModel(C.pcInitial(view));
  assert.deepEqual(m.hints, [hint]);
  assert.deepEqual(m.actions.map((a) => a.verdict), ['approve', 'cheaper', 'quality', 'cancel'], 'edit stays allowed but has nothing to offer');
  assert.equal(C.pcReduce(C.pcInitial(view), {type: 'edit'}).mode, 'view', 'edit mode does not open');
  const doc = fakeDoc();
  const host = doc.createElement('div');
  C.pcDraw(doc, host, m, () => {});
  assert.ok(host.findAll((e) => e.className === 'pc-hint').some((e) => e.textContent === 'ℹ ' + hint));
  assert.ok(!host.findAll((e) => e.tagName === 'BUTTON').some((b) => b.textContent === 'Edit rows…'));
  // An older agent sends neither field: nothing changes.
  const old = C.pcModel(C.pcInitial(plan()));
  assert.deepEqual(old.hints, []);
  assert.ok(old.actions.some((a) => a.verdict === 'edit'));
  // A milestone's edit (Correct…) is not the plan's.
  assert.ok(C.pcModel(C.pcInitial(milestone({plan: Object.assign(plan().plan, {editable: false})}))).actions.some((a) => a.verdict === 'edit'));
});

test('a milestone lists its criteria facts ✓ ✕ ? with the brief\'s text, as the TUI card', () => {
  const base = milestone();
  const view = milestone({
    brief: Object.assign({}, base.brief, {criteria: [{id: 'c1', text: 'legal moves only'}, {id: 'c2', text: 'Looks right'}]}),
    milestones: [Object.assign({}, base.milestones[0], {criteriaFacts: [
      {id: 'c1', state: 'passed'},
      {id: 'c2', state: 'unverified', why: 'no vision-capable reviewer'},
      {id: 'c3', state: 'failed', why: 'check exited 1'},
    ]}), base.milestones[1]],
  });
  const m = C.pcModel(C.pcInitial(view));
  assert.deepEqual(m.milestones[0].facts, [
    {state: 'passed', text: '✓ c1 passed: legal moves only'},
    {state: 'unverified', text: '? c2 unverified: Looks right (no vision-capable reviewer)'},
    {state: 'failed', text: '✕ c3 failed (check exited 1)'},
  ]);
  assert.deepEqual(m.milestones[1].facts, []);
  const doc = fakeDoc();
  const host = doc.createElement('div');
  C.pcDraw(doc, host, m, () => {});
  const lines = host.findAll((e) => /\bpc-fact\b/.test(e.className));
  assert.deepEqual(lines.map((e) => [e.className, e.textContent]), [
    ['pc-fact is-passed', '✓ c1 passed: legal moves only'],
    ['pc-fact is-unverified', '? c2 unverified: Looks right (no vision-capable reviewer)'],
    ['pc-fact is-failed', '✕ c3 failed (check exited 1)'],
  ]);
});

test('a milestone\'s pictures are listed as text: count, caption with its criteria, file name; no image, no file URL', () => {
  const base = milestone();
  const view = milestone({milestones: [Object.assign({}, base.milestones[0], {attachments: [
    {path: '/state/fusion-runs/r1/shots/board.png', caption: 'The board', criteria: ['c1', 'c2']},
    {path: 'C:\\state\\fusion-runs\\r1\\shots\\menu.png', caption: '<img src=x onerror=alert(1)>'},
  ]}), base.milestones[1]]});
  const m = C.pcModel(C.pcInitial(view));
  assert.deepEqual(m.milestones[0].pictures, ['The board [c1, c2] · board.png', '<img src=x onerror=alert(1)> · menu.png']);
  assert.deepEqual(m.milestones[1].pictures, []);
  const doc = fakeDoc();
  const host = doc.createElement('div');
  C.pcDraw(doc, host, m, () => {});
  assert.deepEqual(host.findAll((e) => e.className === 'pc-pictures-count').map((e) => e.textContent), ['2 pictures']);
  assert.deepEqual(host.findAll((e) => e.className === 'pc-picture').map((e) => e.textContent), ['▣ The board [c1, c2] · board.png', '▣ <img src=x onerror=alert(1)> · menu.png']);
  assert.ok(!doc.all.some((e) => e.tagName === 'IMG' || e.tagName === 'A'), 'no image and no link');
  assert.ok(!doc.all.some((e) => Object.values(e.attrs).some((v) => /file:|\/state\//.test(v)) || /file:/.test(e.textContent)), 'no path or file URL');
  assert.ok(!/\/state\/fusion-runs/.test(host.textContent), 'the full path is not shown');
});

test('the card follows the chat only while the chat room is on screen (not over Studio or another room)', () => {
  const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  const fn = src.match(/function projectCardFollow\(\)[\s\S]*?\n}\n/)[0];
  const followed = [];
  const S = {agentSession: 'ses-1', room: 'chat'};
  const run = new Function('S', 'PCARD', 'PCARD_GEN', 'AGENT_GEN', 'PCWATCH', fn + '\nreturn projectCardFollow;')(
    S, {follow: (sid) => followed.push(sid), reset() {}}, 0, 0, null);
  run();
  S.room = 'studio'; run();
  S.room = 'tasks'; run();
  S.room = 'chat'; run();
  assert.deepEqual(followed, ['ses-1', null, null, 'ses-1']);
});

test('the card says "Fusion project", not the sidebar\'s folder "project"', () => {
  assert.equal(C.pcModel(C.pcInitial(brief())).headline, 'The Fusion project brief waits for your approval');
  assert.equal(C.pcDecision(C.pcInitial(closed()), 'ses-1', 'approve').error, 'Nothing in the Fusion project waits for you');
  const armed = C.pcModel(Object.assign(C.pcInitial(plan()), {confirmCancel: true})).actions.find((a) => a.verdict === 'cancel');
  assert.match(armed.why, /cancel the Fusion project/);
  assert.match(C.pcOutcome({supported: false}).error, /Fusion project decisions/);
  assert.match(C.pcOutcome({ok: false, code: 'stale-version', view: null}).notice, /^The Fusion project changed/);
  const doc = fakeDoc();
  const host = doc.createElement('div');
  C.pcDraw(doc, host, C.pcModel(C.pcInitial(plan())), () => {});
  assert.equal(host.children[0].getAttribute('aria-label'), 'Fusion project');
  const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(renderer, /data-act="project:show" title="Show the Fusion project card again">Show Fusion project<\/button>/);
  // Every user-facing sentence of the card that names a project names the Fusion one.
  const card = readFileSync(new URL('../renderer/project-card.js', import.meta.url), 'utf8');
  const strings = [...card.matchAll(/'([^'\n]*)'/g)].map((x) => x[1]).filter((t) => /\bproject\b/i.test(t) && /\s/.test(t));
  assert.deepEqual(strings.filter((t) => !/Fusion project/.test(t)), []);
});

/* ---------------- the real submit() with stand-ins for the page ---------------- */

/**
 * renderer.js's own submit(), bswGatedTurn(), gatedTurnLeft() and
 * projectCardContinue() run against stand-ins: every name they read that
 * is not one of theirs comes from `env` (a `with` scope), so an assignment
 * such as `DRAIN_OWED = true` lands there too.
 */
function realPage(over = {}) {
  const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  const take = (re) => src.match(re)[0];
  const fns = [
    take(/\nfunction submit\(preparedSkillText, opts\) \{[\s\S]*?\n}\n/),
    take(/\nfunction gatedTurnLeft\(text\) \{[\s\S]*?\n}\n/),
    take(/\nfunction bswGatedTurn\(text\) \{[\s\S]*?\n}\n/),
    take(/\nfunction projectCardContinue\([\s\S]*?\n}\n/),
  ].join('\n');
  const toasts = [], turns = [], snapshots = [];
  const env = Object.assign({
    S: {agentSession: 'ses-1', sessionId: 'ses-1', room: 'chat', settings: null, busy: false, pending: null, live: {state: 'connected'}, draft: '', log: [], queued: [], slash: false},
    VOICE: {state: 'idle'}, BSW: {gating: false}, SK: {workingDir: null}, SLASH: [], OPENING: {}, SWX: {sendError: null},
    DRAIN_OWED: false, MAX_QUEUED: 20, EXECUTE_PLAN_MESSAGE: '\u0000', PLAN_TRACE: [], ANX: {messageAction() {}},
    FIT_HOLD_TITLE: 'A model test is running', FIT_HOLD_TEXT: 'Your message stays here.',
    voiceStop() {}, starterHoldsSend: () => false, fitHoldsSend: () => false, updHoldsNewChat: () => false,
    openHoldsComposer: () => false, swxWaitsForRoute: () => false, attPreparing: () => false,
    attComposeMessage: (t) => t, attClearSent() {}, attToEditor: (t) => t,
    toast: (...a) => toasts.push(a), $: () => null, autosize() {}, ctxDraftChanged() {}, render() {}, refreshSend() {},
    runSlash() {}, submitSkillCommand() {}, noteWaitingChat() {}, drainOwed() {}, dropStaleGateNotices() {},
    approvalOpen: () => null, steerOrQueue() {}, queueKey: () => 'k', apprKeyLabel: (k) => k,
    nid: (() => { let n = 0; return () => ++n; })(), esc: (t) => t,
    gate: {kind: 'run'}, localTurnGate: () => env.gate,
    bswSnapshot: () => new Promise((r) => snapshots.push(r)),
    startLiveTurn: (t) => turns.push(t), pcCanContinue: C.pcCanContinue, crypto: globalThis.crypto,
  }, over);
  const scope = new Proxy(env, {has: (t, k) => k in t});
  const page = new Function('scope', 'with (scope) {\n' + fns + '\nreturn {submit, projectCardContinue, bswGatedTurn};\n}')(scope);
  return {page, env, toasts, turns, snapshots};
}

test('the real submit() answers false on a hold and leaves the box alone', () => {
  const r = realPage({fitHoldsSend: () => true});
  r.env.S.draft = 'my words';
  assert.equal(r.page.submit('Go on.', {plain: true}), false);
  assert.equal(r.env.S.draft, 'my words');
  assert.deepEqual(r.turns, []);
  assert.equal(r.toasts[0][0], 'A model test is running');
  const ok = realPage();
  assert.equal(ok.page.submit('Go on.', {plain: true}), true);
  assert.deepEqual(ok.turns, ['Go on.']);
});

test('a continue on a local route without its model stays pending and never touches the person\'s draft', async () => {
  // The gate already knows: nothing is submitted, the continue waits.
  const r = realPage({gate: {kind: 'block', text: 'local model m is not downloaded'}});
  r.env.S.draft = 'my words';
  assert.equal(r.page.projectCardContinue('ses-1', 'Go on.'), false);
  assert.equal(r.env.S.draft, 'my words');
  assert.deepEqual(r.env.S.log, []);
  // The gate learns it only after the disk snapshot: the continue went back to the editor, above the person's draft.
  const a = realPage({gate: {kind: 'pending'}});
  a.env.S.draft = 'my words';
  assert.equal(a.page.projectCardContinue('ses-1', 'Go on.'), true);
  assert.equal(a.env.S.draft, 'my words', 'restored while the snapshot runs');
  a.env.gate = {kind: 'block', text: 'local model m is not downloaded'};
  a.snapshots[0](); await tick();
  assert.equal(a.env.S.draft, 'Go on.\n\nmy words', 'nothing the person typed is written over');
  // A message the person typed comes back as before (the box was empty).
  const t = realPage({gate: {kind: 'block', text: 'blocked'}});
  t.env.S.draft = 'typed';
  assert.equal(t.page.submit(), true);
  assert.equal(t.env.S.draft, 'typed');
});

test('a continue is not put in the switch queue (× or another chat could drop it): it waits for the switch', () => {
  const typed = realPage({swxWaitsForRoute: () => true});
  typed.env.S.draft = 'typed';
  assert.equal(typed.page.submit(), true, 'a typed message is queued as before');
  assert.deepEqual(typed.env.S.queued, ['typed']);
  assert.equal(typed.env.DRAIN_OWED, true);
  for (const [label, over] of [
    ['the route switching', {swxWaitsForRoute: () => true}],
    ['a queue owed', {DRAIN_OWED: true}],
    ['the last send failed during a switch', {SWX: {sendError: 'x'}}],
  ]) {
    const r = realPage(over);
    r.env.S.draft = 'my words';
    assert.equal(r.page.projectCardContinue('ses-1', 'Go on.'), false, label);
    assert.deepEqual(r.env.S.queued, [], label);
    assert.equal(r.env.S.draft, 'my words', label);
  }
});
