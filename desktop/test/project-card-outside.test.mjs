// Issue #109, part 2: the project card says when the open gate changed
// outside Atomic Agent (and approving still works, never by itself), and
// a chat whose project could not be opened gets a card with the problem
// and what to do instead of nothing.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../renderer/project-card.js');

const plan = (over = {}) => Object.assign({
  schema: 1, sessionId: 'ses-1', gate: {kind: 'plan'}, version: 3,
  allowedVerdicts: ['approve', 'edit', 'cancel'], cancelled: false,
  brief: {what: 'A chess game', successCriteria: [], status: 'approved', draftedAfterUntrusted: false},
  plan: {status: 'draft', version: 2, draftedAfterUntrusted: true, editable: false, rows: [], totals: null},
  milestones: [{id: 'm1', title: 'Base', state: 'done'}], violations: [], hints: [],
}, over);

function fakeDoc() {
  const doc = {activeElement: null};
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this._text = ''; this.className = ''; this.hidden = false; this.disabled = false; }
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
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    fire(type) { for (const fn of this.listeners[type] || []) fn({target: this}); }
    findAll(pred) { const out = []; const walk = (e) => { if (pred(e)) out.push(e); e.children.forEach(walk); }; walk(this); return out; }
  }
  return Object.assign(doc, {createElement: (t) => new El(t)});
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('the core\'s changed-outside hint is the one the card replaces with its warning', () => {
  const core = readFileSync(new URL('../../src/tools/fusion/project-gate-view.ts', import.meta.url), 'utf8');
  const m = core.match(/export const CHANGED_OUTSIDE_HINT =\s*\n?\s*("(?:[^"\\]|\\.)*")/);
  assert.equal(C.PC_CHANGED_OUTSIDE_HINT, JSON.parse(m[1]));
});

test('a gate changed outside Atomic Agent leads with a warning naming that gate; the hint is not said twice', () => {
  for (const [view, what] of [
    [plan({gate: {kind: 'brief'}}), 'brief'],
    [plan(), 'plan'],
    [plan({gate: {kind: 'milestone', id: 'm1'}}), 'milestone “Base”'],
  ]) {
    const model = C.pcModel(C.pcInitial(Object.assign(view, {changedOutside: true, hints: [C.PC_CHANGED_OUTSIDE_HINT, 'Only one worker is available.']})));
    assert.equal(model.changedOutside, true);
    assert.equal(model.warnings[0], C.pcChangedOutsideWarning(view));
    assert.ok(model.warnings[0].includes('The ' + what + ' changed outside Atomic Agent'), model.warnings[0]);
    assert.ok(model.warnings[0].includes('review it before approving'));
    assert.deepEqual(model.hints, ['Only one worker is available.']);
  }
  const plain = C.pcModel(C.pcInitial(plan()));
  assert.equal(plain.changedOutside, false);
  assert.ok(!plain.warnings.some((w) => w.includes('outside Atomic Agent')));
});

test('Approve on a changed gate still works, with the warning on the button, and nothing approves by itself', async () => {
  const sent = [];
  const drawn = [];
  const view = plan({changedOutside: true, hints: [C.PC_CHANGED_OUTSIDE_HINT]});
  const card = C.createProjectCard({
    api: {read: async () => ({supported: true, ok: true, view}), decide: async (body) => { sent.push(body); return {supported: true, ok: true, view: plan({gate: {kind: 'none'}, version: 3}), continueMessage: null}; }},
    draw: (model, on) => drawn.push({model, on}),
    onContinue: () => true,
  });
  card.follow('ses-1');
  await tick();
  assert.deepEqual(sent, [], 'reading a changed gate sends no decision');
  const model = drawn.at(-1).model;
  const approve = model.actions.find((a) => a.verdict === 'approve');
  assert.equal(approve.disabled, false);
  assert.match(approve.why, /changed outside Atomic Agent/);
  const doc = fakeDoc();
  const host = doc.createElement('div');
  C.pcDraw(doc, host, model, drawn.at(-1).on);
  assert.equal(host.findAll((e) => e.className === 'pc-warn pc-outside').length, 1);
  host.findAll((e) => e.tagName === 'BUTTON' && e.textContent === 'Approve')[0].fire('click');
  await tick(); await tick();
  assert.deepEqual(sent, [{session: 'ses-1', gate: {kind: 'plan'}, version: 3, verdict: 'approve'}]);
});

test('a chat whose project did not open gets a problem card with what to do', async () => {
  const drawn = [];
  const card = C.createProjectCard({
    api: {read: async (sid) => (sid === 'broken' ? {supported: true, ok: true, view: null, problem: 'project.json is not valid JSON; it was left as it is.'} : {supported: true, ok: true, view: null}), decide: async () => ({})},
    draw: (model, on) => drawn.push({model, on}),
    onContinue: () => true,
  });
  card.follow('broken');
  await tick();
  const model = drawn.at(-1).model;
  assert.equal(model.kind, 'problem');
  assert.equal(model.problem, 'project.json is not valid JSON; it was left as it is.');
  assert.match(model.todo, /project\.json/);
  assert.match(model.todo, /Nothing is approved/);
  const doc = fakeDoc();
  const host = doc.createElement('div');
  C.pcDraw(doc, host, model, drawn.at(-1).on);
  assert.equal(host.hidden, false);
  assert.ok(host.textContent.includes(model.problem));
  assert.ok(host.textContent.includes(C.PC_PROBLEM_HEADLINE));
  assert.deepEqual(host.findAll((e) => e.tagName === 'BUTTON').map((b) => b.textContent), ['Hide'], 'no verdict to give');
  host.findAll((e) => e.tagName === 'BUTTON')[0].fire('click');
  assert.equal(drawn.at(-1).model, null, 'Hide puts it away');
  // Another chat without a project draws nothing; coming back shows the problem again.
  card.follow('plain');
  await tick();
  assert.equal(drawn.at(-1).model, null);
  card.follow('broken');
  assert.equal(drawn.at(-1).model.kind, 'problem', 'kept from the last read');
  // Once the project opens again, the gate replaces the problem.
  card.onFrame({sessionId: 'broken', view: plan({sessionId: 'broken'})});
  assert.equal(drawn.at(-1).model.gate, 'plan');
});
