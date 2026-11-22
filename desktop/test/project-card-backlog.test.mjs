// Issue #146, Desktop: the person decides backlog items in the Fusion
// project card (renderer/project-card.js), the same calls as the TUI's
// backlog (press b in /plan) and `atomic-agent project backlog
// --promote|--drop|--reopen`. The project states come from the real core
// (session-project.ts, project-backlog.ts, plan-checks.ts); the view's
// backlog is shaped as src/tools/fusion/project-gate-view.ts shapes it.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadCore } from './core-ts.mjs';

const require = createRequire(import.meta.url);
const C = require('../renderer/project-card.js');

// node:vm and node:crypto as in project-card.test.mjs: the check lint's
// validator and the review record's hashing; nothing here runs either.
const EXTRA = ['node:vm', 'node:crypto'];
const CORE = loadCore(new URL('../../src/session/session-project.ts', import.meta.url), EXTRA);
const BL = loadCore(new URL('../../src/session/project-backlog.ts', import.meta.url), EXTRA);
const CHECKS = loadCore(new URL('../../src/tools/fusion/plan-checks.ts', import.meta.url), EXTRA);
const TEXT = loadCore(new URL('../../src/session/project-gate-text.ts', import.meta.url), EXTRA);
const VIEW_SRC = readFileSync(new URL('../../src/tools/fusion/project-gate-view.ts', import.meta.url), 'utf8');

/* ---------------- a real project ---------------- */

const row = (taskId, milestoneId, backlog) => ({taskId, title: 'Task ' + taskId, milestoneId, worker: 'openrouter:w-a', reviewer: null,
  reason: 'preset', basis: 'preset', samples: 0, estCostUsd: 0.1, estMs: 1000, ...(backlog ? {backlog} : {})});

/** A project at the plan gate with four backlog items: b1 open, b2 a seed, b3 and b4 for the person to decide. */
function project({cite} = {}) {
  let now = 1000, p;
  const take = (r) => { assert.ok(r.ok, JSON.stringify(r.error)); p = r.project; };
  take(CORE.applyProjectUpdate(undefined, {kind: 'brief', brief: {what: 'A chess game', users: 'two players', how: 'a web page', successCriteria: ['legal moves']}, draftedAfterUntrusted: false}, now++));
  take(CORE.applyProjectDecision(p, {gate: p.gate, version: CORE.gateVersion(p), verdict: 'approve'}, {now: now++}));
  for (const item of [
    {title: 'Undo button', source: 'director'},
    {title: 'Online play', condition: 'the local game is stable', source: 'director'},
    {title: 'Dark <b>theme</b>', note: 'From <img src=x onerror=alert(1)>', source: 'director'},
    {title: 'Sound', source: 'director'},
  ]) take(CORE.applyProjectUpdate(p, {kind: 'backlog_add', item}, now++));
  take(CORE.applyProjectUpdate(p, {kind: 'plan', milestones: [{id: 'm1', title: 'Base', kind: 'base'}, {id: 'm2', title: 'Logic', kind: 'logic'}],
    rows: [row('t1', 'm1', cite ? ['b3'] : undefined), row('t2', 'm2')], detail: 'full'}, now++));
  return p;
}

const call = (p, id, state) => { const r = BL.applyBacklogDecision(p, {id, state}); assert.ok(r.ok, JSON.stringify(r.error)); return r.project; };

/** The backlog and hints of the view, as projectGateView builds them (src/tools/fusion/project-gate-view.ts). */
function view(p, over = {}) {
  const plan = p.plan;
  const hints = [];
  if (p.gate.kind === 'plan' && plan) {
    const criteria = p.approvedCriteria ?? (p.brief?.status === 'approved' ? p.brief.successCriteria : []);
    hints.push(...CHECKS.evaluatePlanChecks(plan.rows, criteria, CORE.planCheckData(p, plan)).map(CHECKS.planCheckHint));
  }
  if (p.gate.kind === 'plan' || p.gate.kind === 'milestone') for (const s of BL.openSeeds(p)) hints.push(TEXT.seedHint(s.id, s.title, s.condition));
  const expectation = CORE.projectExpectation(p);
  if (expectation.kind === 'complete' && expectation.promotedNotDone !== undefined) {
    const n = expectation.promotedNotDone;
    hints.push(`complete with ${n} promoted backlog item${n === 1 ? '' : 's'} not done: ${BL.promotedForPlan(p).map((b) => `${b.id} ${b.title}`).join(', ')}`);
  }
  const backlog = (p.backlog ?? []).length === 0 && BL.staleBacklogCalls(p).length === 0 ? undefined : {
    open: BL.openBacklog(p).length,
    seeds: BL.openSeeds(p).map((b) => ({id: b.id, title: b.title, condition: b.condition})),
    promoted: BL.promotedForPlan(p).map((b) => ({
      id: b.id, title: b.title,
      ...(p.backlogCalls?.[b.id]?.deferred === true ? {deferred: true} : {}),
      citedBy: (plan?.rows ?? []).filter((r) => (r.backlog ?? []).includes(b.id)).map((r) => r.taskId),
    })),
    stale: BL.staleBacklogCalls(p),
    items: (p.backlog ?? []).map((b) => {
      const promoted = BL.backlogStateOf(p, b.id) === 'promoted';
      const plannedIn = promoted ? BL.backlogTakenIn(p, b.id) : undefined;
      const deferred = promoted && plannedIn === undefined && p.backlogCalls?.[b.id]?.deferred === true;
      return {...b, state: BL.backlogStateOf(p, b.id), ...(plannedIn === undefined ? {} : {plannedIn}), ...(deferred ? {deferred: true} : {})};
    }),
  };
  return Object.assign({
    schema: 1, sessionId: 'ses-1', gate: p.gate, version: CORE.gateVersion(p),
    allowedVerdicts: p.cancelledAt !== undefined ? [] : CORE.allowedProjectVerdicts(p.gate),
    expectation, cancelled: p.cancelledAt !== undefined, brief: p.brief ?? null,
    plan: plan ? {status: plan.status, detail: plan.detail, version: plan.version, draftedAfterUntrusted: plan.draftedAfterUntrusted,
      rows: plan.rows.map((r) => ({...r, selectableWorkers: ['openrouter:w-a', 'openrouter:w-b'], selectableReviewers: []})), totals: plan.totals} : null,
    milestones: p.milestones.map((m) => ({...m, estCostUsd: null, estMs: null})), violations: [], hints,
    ...(backlog ? {backlog} : {}),
  }, over);
}

/* ---------------- the plan checks ---------------- */

test('backlog-coverage renders through the plan checks, not as a loose hint', () => {
  const v = view(call(project(), 'b3', 'promoted'));
  const hint = v.hints.find((h) => h.startsWith('backlog-coverage: fail: '));
  assert.ok(hint, 'the real core says backlog-coverage fails: ' + JSON.stringify(v.hints));
  const model = C.pcModel(C.pcInitial(v));
  const check = model.checks.find((c) => c.dimension === 'backlog-coverage');
  assert.deepEqual(check && {verdict: check.verdict, detail: check.detail}, {verdict: 'fail', detail: hint.slice('backlog-coverage: fail: '.length)});
  assert.equal(model.hints.includes(hint), false, 'not drawn twice');
  const pass = C.pcModel(C.pcInitial(view(call(project({cite: true}), 'b3', 'promoted'))));
  assert.equal(pass.checks.find((c) => c.dimension === 'backlog-coverage')?.verdict, 'pass');
});

test('the card reads every plan check dimension the core names', () => {
  const src = readFileSync(new URL('../../src/tools/fusion/plan-checks.ts', import.meta.url), 'utf8');
  const dims = [...src.match(/export type PlanCheckDimension = ([^;]*);/)[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(dims.includes('backlog-coverage'));
  for (const d of dims) {
    const model = C.pcModel(C.pcInitial(view(project(), {hints: [d + ': warn: something']})));
    assert.deepEqual(model.checks.map((c) => c.dimension), [d], d);
  }
});

/* ---------------- the DOM and the controller ---------------- */

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
const draw = (model, on = () => {}) => { const doc = fakeDoc(); const host = doc.createElement('div'); C.pcDraw(doc, host, model, on); return host; };
const buttons = (host) => host.findAll((e) => e.tagName === 'BUTTON');
const byLabel = (host, label) => buttons(host).find((b) => b.getAttribute('aria-label') === label);
const tick = () => new Promise((r) => setTimeout(r, 0));

function controller({backlog, decide, read, turnRunning}) {
  const drawn = [];
  const card = C.createProjectCard({
    ...(turnRunning ? {turnRunning} : {}),
    api: {read: async (sid) => (read ? read(sid) : {supported: true, ok: true, view: null}), decide: async (body) => decide(body), backlog: async (body) => backlog(body)},
    draw: (model, on) => drawn.push({model, on}),
    onContinue: () => true,
  });
  return {card, last: () => drawn.at(-1)};
}

test('the backlog section lists every item with its call, author text as text, and the buttons each state takes', () => {
  let p = project();
  p = call(p, 'b3', 'promoted');
  p = call(p, 'b4', 'dropped');
  const host = draw(C.pcModel(C.pcInitial(view(p))));
  const section = host.findAll((e) => e.className === 'pc-backlog')[0];
  assert.ok(section, 'a Backlog section');
  assert.match(section.textContent, /^Backlog/);
  assert.match(section.textContent, /2 open · 1 seed · 1 promoted/);
  assert.match(section.textContent, /b3 · Dark <b>theme<\/b>/, 'the title as the author wrote it');
  assert.match(section.textContent, /From <img src=x onerror=alert\(1\)>/);
  assert.equal(host.findAll((e) => e.tagName === 'IMG' || e.tagName === 'B').length, 0, 'never markup');
  assert.match(section.textContent, /b2 · Online play[\s\S]*seed · When: the local game is stable/);
  assert.match(section.textContent, /promoted, not in any plan/);
  assert.match(section.textContent, /b4 · Sound[\s\S]*dropped/);
  assert.deepEqual(['b1', 'b2', 'b3', 'b4'].map((id) => buttons(section).filter((b) => / b\d$/.test(b.getAttribute('aria-label') || '') && b.getAttribute('aria-label').endsWith(' ' + id)).map((b) => b.textContent)),
    [['Promote', 'Drop'], ['Promote', 'Drop'], ['Drop', 'Reopen', 'Defer'], ['Promote', 'Reopen']], 'at the plan gate a promoted item waiting for it can be deferred too');
  // The seed's own hint is drawn by the section, not again as a loose line.
  assert.equal(host.findAll((e) => e.className === 'pc-hint' && /^ℹ seed /.test(e.textContent)).length, 0);
});

test('a call made stale outside Atomic Agent is flagged with what to do, and a removed item can be cleared', () => {
  let p = call(call(project(), 'b3', 'promoted'), 'b4', 'dropped');
  // b3 edited by hand in project.json; b4 removed (a dropped item removed is no stale call), so promote b1 and remove it.
  p = call(p, 'b1', 'promoted');
  p = {...p, backlog: p.backlog.filter((b) => b.id !== 'b1').map((b) => (b.id === 'b3' ? {...b, title: 'Dark theme and high contrast'} : b))};
  const v = view(p);
  assert.equal(JSON.stringify(v.backlog.stale.map((s) => [s.id, s.reason]).sort()), JSON.stringify([['b1', 'removed'], ['b3', 'changed']]));
  const host = draw(C.pcModel(C.pcInitial(v)));
  const section = host.findAll((e) => e.className === 'pc-backlog')[0];
  assert.match(section.textContent, /b3 · Dark theme and high contrast[\s\S]*changed outside Atomic Agent since you promoted it: it reads open again/);
  assert.match(section.textContent, /b1[\s\S]*removed outside Atomic Agent since you promoted it/);
  assert.deepEqual(buttons(section).filter((b) => (b.getAttribute('aria-label') || '').endsWith(' b3')).map((b) => b.textContent), ['Promote again', 'Drop', 'Keep open']);
  assert.deepEqual(buttons(section).filter((b) => (b.getAttribute('aria-label') || '').endsWith(' b1')).map((b) => b.textContent), ['Clear']);
  assert.equal(host.findAll((e) => e.className === 'pc-warn-item').length, 2, 'both flagged as warnings');
});

test('Promote sends {sessionId, item, state} through the backlog call; the view it answers is drawn, the gate stays', async () => {
  const sent = [];
  let p = project();
  const c = controller({
    read: () => ({supported: true, ok: true, view: view(p)}),
    backlog: (body) => { sent.push(body); p = call(p, body.item, body.state); return {supported: true, ok: true, view: view(p)}; },
    decide: () => { throw new Error('a backlog call is not a gate verdict'); },
  });
  c.card.follow('ses-1');
  await tick();
  const host = draw(c.last().model, c.last().on);
  byLabel(host, 'Promote b3').fire('click');
  assert.equal(c.last().model.busy, true);
  await tick(); await tick();
  assert.deepEqual(sent, [{sessionId: 'ses-1', item: 'b3', state: 'promoted'}]);
  const after = c.last().model;
  assert.equal(after.busy, false);
  assert.equal(after.gate, 'plan');
  assert.equal(after.backlog.items.find((i) => i.id === 'b3').state, 'promoted');
  assert.match(after.notice, /b3 promoted/);
  byLabel(draw(after, c.last().on), 'Reopen b3').fire('click');
  await tick(); await tick();
  assert.deepEqual(sent.at(-1), {sessionId: 'ses-1', item: 'b3', state: 'open'});
  assert.equal(c.last().model.backlog.items.find((i) => i.id === 'b3').state, 'open');
});

test('a refused backlog call keeps the card and says why; a turn running asks to wait', async () => {
  const p = project();
  const answers = [
    {supported: true, ok: false, status: 409, code: 'turn-running', error: 'a turn is running', view: view(p)},
    {supported: true, ok: false, status: 400, code: 'invalid', error: 'the backlog has no item b3', view: view(p)},
    {supported: false},
  ];
  const c = controller({read: () => ({supported: true, ok: true, view: view(p)}), backlog: () => answers.shift(), decide: () => ({})});
  c.card.follow('ses-1');
  await tick();
  c.last().on({type: 'backlog', id: 'b3', state: 'promoted'});
  await tick(); await tick();
  assert.match(c.last().model.error, /turn is running/);
  c.last().on({type: 'backlog', id: 'b3', state: 'promoted'});
  await tick(); await tick();
  assert.equal(c.last().model.error, 'the backlog has no item b3');
  c.last().on({type: 'backlog', id: 'b3', state: 'promoted'});
  await tick(); await tick();
  assert.match(c.last().model.error, /update it/);
  assert.equal(c.last().model.gate, 'plan');
});

test('the card offers only calls the view allows: no unknown item, no state the item already has', async () => {
  const sent = [];
  const c = controller({read: () => ({supported: true, ok: true, view: view(project())}), backlog: (b) => { sent.push(b); return {supported: true, ok: true, view: view(project())}; }, decide: () => ({})});
  c.card.follow('ses-1');
  await tick();
  for (const a of [{id: 'b9', state: 'promoted'}, {id: 'b1', state: 'open'}, {id: 'b1', state: 'deferred'}]) c.last().on({type: 'backlog', ...a});
  await tick();
  assert.deepEqual(sent, []);
  assert.ok(c.last().model.error);
});

test('the backlog hints the section says itself are the core\'s own sentences', () => {
  for (const template of [
    '`promoted from the backlog: ${id} "${title}": check this plan takes it in before approving`',
    '`promoted from the backlog, deferred by you: ${id} "${title}": this plan need not take it in; set it active again to require it`',
    '`promoted item ${s.id} was removed outside Atomic Agent`',
    '`backlog item ${s.id} changed since you ${s.state} it: it reads open again; ${s.state === "promoted" ? "promote" : "drop"} it again if you still want it`',
  ]) assert.ok(VIEW_SRC.includes(template), template);
  const hints = C.pcBacklogModel({backlog: {open: 1, seeds: [{id: 'b2', title: 'T', condition: 'c'}], promoted: [{id: 'b3', title: 'U'}],
    stale: [{id: 'b5', state: 'promoted', reason: 'removed'}, {id: 'b6', state: 'dropped', reason: 'changed'}], items: []}}).hints;
  assert.ok(hints.has(TEXT.seedHint('b2', 'T', 'c')));
  assert.ok(hints.has('promoted from the backlog: b3 "U": check this plan takes it in before approving'));
  assert.ok(hints.has('promoted from the backlog, deferred by you: b3 "U": this plan need not take it in; set it active again to require it'));
  assert.ok(hints.has('promoted item b5 was removed outside Atomic Agent'));
  assert.ok(hints.has('backlog item b6 changed since you dropped it: it reads open again; drop it again if you still want it'));
});

test('the page hands the card the bridge\'s backlog call', () => {
  const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(renderer, /createProjectCard\(\{\s*api: \{[^\n]*backlog: \(body\) => BR\.projectBacklog\(body\)/);
});

/* ---------------- the plan gate: cited by, defer, reactivate ---------------- */

test('at the plan gate a promoted item not taken in says which tasks cite it, with Defer or Reactivate', () => {
  const p = call(call(project(), 'b3', 'promoted'), 'b1', 'promoted');
  const cited = call(call(project({cite: true}), 'b3', 'promoted'), 'b1', 'promoted');
  const section = (v) => draw(C.pcModel(C.pcInitial(v))).findAll((e) => e.className === 'pc-backlog')[0];
  const s = section(view(p));
  assert.match(s.textContent, /b3 · Dark <b>theme<\/b>[\s\S]*No citing tasks/);
  assert.deepEqual(buttons(s).filter((b) => (b.getAttribute('aria-label') || '').endsWith(' b3')).map((b) => b.textContent), ['Drop', 'Reopen', 'Defer']);
  assert.match(section(view(cited)).textContent, /Cited by: t1/);
  // Deferred by the person at the plan gate (the core's own edit).
  const r = CORE.applyProjectDecision(p, {gate: p.gate, version: CORE.gateVersion(p), verdict: 'edit', edits: {backlogStatus: {b3: 'deferred'}}}, {now: 5000});
  assert.ok(r.ok, JSON.stringify(r.error));
  const d = section(view(r.project));
  assert.match(d.textContent, /promoted, deferred at the plan gate, not in any plan/);
  assert.deepEqual(buttons(d).filter((b) => (b.getAttribute('aria-label') || '').endsWith(' b3')).map((b) => b.textContent), ['Drop', 'Reopen', 'Reactivate']);
  // Elsewhere than the plan gate there is no plan to cite it.
  const m = section(view(p, {gate: {kind: 'milestone', id: 'm1'}, allowedVerdicts: ['approve', 'edit', 'cancel']}));
  assert.equal(/Cited by|No citing tasks/.test(m.textContent), false);
  assert.equal(buttons(m).some((b) => b.textContent === 'Defer'), false);
});

test('Defer sends the plan gate\'s edit with backlogStatus at the view\'s version, and the core takes it', async () => {
  const sent = [];
  let p = call(project(), 'b3', 'promoted');
  const c = controller({
    read: () => ({supported: true, ok: true, view: view(p)}),
    decide: (body) => {
      sent.push(body);
      const r = CORE.applyProjectDecision(p, {gate: body.gate, version: body.version, verdict: body.verdict, edits: body.edits}, {now: 6000});
      assert.ok(r.ok, JSON.stringify(r.error));
      p = r.project;
      return {supported: true, ok: true, view: view(p), continueMessage: null};
    },
    backlog: () => { throw new Error('a defer is a plan gate edit, not a backlog call'); },
  });
  c.card.follow('ses-1');
  await tick();
  const version = c.last().model.version;
  byLabel(draw(c.last().model, c.last().on), 'Defer b3').fire('click');
  await tick(); await tick();
  assert.deepEqual(sent, [{session: 'ses-1', gate: {kind: 'plan'}, version, verdict: 'edit', edits: {backlogStatus: {b3: 'deferred'}}}]);
  const after = c.last().model;
  assert.equal(after.checks.find((x) => x.dimension === 'backlog-coverage')?.verdict, 'pass', 'a deferred item no longer blocks the plan');
  byLabel(draw(after, c.last().on), 'Reactivate b3').fire('click');
  await tick(); await tick();
  assert.deepEqual(sent.at(-1).edits, {backlogStatus: {b3: 'active'}});
  assert.equal(c.last().model.checks.find((x) => x.dimension === 'backlog-coverage')?.verdict, 'fail');
});

test('a backlog status edit the view does not offer is not sent', () => {
  const st = C.pcInitial(view(call(project(), 'b3', 'promoted')));
  assert.ok(C.pcDecision(st, 'ses-1', 'edit', {backlog: 'b3', status: 'deferred'}).body);
  for (const edit of [{backlog: 'b3', status: 'active'}, {backlog: 'b1', status: 'deferred'}, {backlog: 'b9', status: 'deferred'}, {backlog: 'b3', status: 'informational'}]) {
    assert.ok(C.pcDecision(st, 'ses-1', 'edit', edit).error, JSON.stringify(edit));
  }
  assert.ok(C.pcDecision(Object.assign({}, st, {mode: 'edit'}), 'ses-1', 'edit', {backlog: 'b3', status: 'deferred'}).error, 'not while editing rows');
});

/* ---------------- between gates and at the close ---------------- */

/** The project run to its end: plan approved with b3 deferred, both milestones reviewed. */
function completed() {
  let now = 7000;
  let p = call(project(), 'b3', 'promoted');
  const take = (r) => { assert.ok(r.ok, JSON.stringify(r.error)); p = r.project; };
  take(CORE.applyProjectDecision(p, {gate: p.gate, version: CORE.gateVersion(p), verdict: 'edit', edits: {backlogStatus: {b3: 'deferred'}}}, {now: now++}));
  take(CORE.applyProjectDecision(p, {gate: p.gate, version: CORE.gateVersion(p), verdict: 'approve'}, {now: now++}));
  for (const id of ['m1', 'm2']) {
    take(CORE.applyProjectUpdate(p, {kind: 'milestone_run', id, runId: 'fr-' + id}, now++));
    take(CORE.applyProjectUpdate(p, {kind: 'milestone', id, state: 'done', summary: 'Done.'}, now++));
    take(CORE.applyProjectDecision(p, {gate: p.gate, version: CORE.gateVersion(p), verdict: 'approve'}, {now: now++}));
  }
  return p;
}

test('a complete project with a promoted item never done says so, and its backlog can still be decided', async () => {
  const p = completed();
  const v = view(p);
  assert.equal(v.gate.kind, 'none');
  assert.equal(v.expectation.kind, 'complete');
  assert.equal(v.expectation.promotedNotDone, 1);
  const sent = [];
  let now = p;
  const c = controller({read: () => ({supported: true, ok: true, view: view(now)}), decide: () => ({}),
    backlog: (body) => { sent.push(body); now = call(now, body.item, body.state); return {supported: true, ok: true, view: view(now)}; }});
  c.card.follow('ses-1');
  await tick();
  const model = c.last().model;
  assert.ok(model, 'the card stays for the backlog once nothing waits at a gate');
  assert.equal(model.kind, 'backlog');
  assert.match(model.completion.join('\n'), /^complete with 1 promoted backlog item not done: b3 Dark <b>theme<\/b>/m);
  const host = draw(model, c.last().on);
  assert.match(host.textContent, /complete with 1 promoted backlog item not done/);
  assert.match(host.textContent, /promoted, deferred at the plan gate, not in any plan/);
  assert.equal(buttons(host).some((b) => ['Approve', 'Defer', 'Reactivate'].includes(b.textContent)), false, 'no gate verdict to give');
  byLabel(host, 'Drop b1').fire('click');
  await tick(); await tick();
  assert.deepEqual(sent, [{sessionId: 'ses-1', item: 'b1', state: 'dropped'}]);
  assert.match(c.last().model.notice, /b1 dropped/);
});

test('between gates the card shows only a backlog that asks something; without one it stays hidden as before', () => {
  const p = completed();
  const st = C.pcStore();
  assert.equal(st.put('ses-1', view(p)), true, 'open items and a promoted item never done');
  let q = p;
  for (const id of ['b1', 'b2', 'b4']) q = call(q, id, 'dropped');
  q = call(q, 'b3', 'open');
  q = call(q, 'b3', 'dropped');
  const quiet = view(q);
  assert.equal(quiet.expectation.promotedNotDone, undefined);
  assert.equal(st.put('ses-1', quiet), true);
  assert.equal(st.get('ses-1'), null, 'every item decided, nothing left to say: no card');
  assert.equal(C.pcModel(C.pcInitial(quiet)), null);
  const running = view(project(), {gate: {kind: 'none'}, version: null, allowedVerdicts: ['cancel'], expectation: {kind: 'run_milestone', id: 'm1'}});
  assert.equal(C.pcModel(C.pcInitial(running)).kind, 'backlog', 'open items between gates');
  assert.equal(C.pcModel(C.pcInitial(view(p, {cancelled: true, allowedVerdicts: []}))), null, 'a cancelled project takes no more calls');
});

test('Hide puts a backlog card away until the chat is opened again', async () => {
  const c = controller({read: () => ({supported: true, ok: true, view: view(completed())}), decide: () => ({}), backlog: () => ({})});
  c.card.follow('ses-1');
  await tick();
  c.last().on({type: 'hide'});
  assert.equal(c.last().model, null);
  assert.equal(c.card.hiddenOpen(), true, 'the header offers Show Fusion project');
  c.card.show();
  assert.equal(c.last().model.kind, 'backlog');
});

/* ---------------- a turn running ---------------- */

test('while a turn runs the backlog card stays away, and at a gate the backlog buttons wait for the turn', async () => {
  let running = true;
  const sent = [];
  const c = controller({read: () => ({supported: true, ok: true, view: view(completed())}), decide: () => ({}),
    backlog: (b) => { sent.push(b); return {supported: true, ok: true, view: view(completed())}; }, turnRunning: (sid) => running && sid === 'ses-1'});
  c.card.follow('ses-1');
  await tick();
  assert.equal(c.last().model, null, 'no backlog card under a running turn');
  assert.equal(c.card.hiddenOpen(), false, 'nor a Show Fusion project for it');
  running = false;
  c.card.follow('ses-1');   // the page's next paint
  assert.equal(c.last().model.kind, 'backlog', 'the turn finished: the backlog is back');
  // At a gate the card stays, with its backlog buttons disabled while a turn runs.
  const g = controller({read: () => ({supported: true, ok: true, view: view(project())}), decide: () => ({}),
    backlog: (b) => { sent.push(b); return {supported: true, ok: true, view: view(project())}; }, turnRunning: () => running});
  running = true;
  g.card.follow('ses-1');
  await tick();
  const model = g.last().model;
  assert.equal(model.gate, 'plan');
  assert.equal(model.backlog.waitTurn, 'Decide once the turn finishes');
  const host = draw(model, g.last().on);
  assert.match(host.findAll((e) => e.className === 'pc-backlog')[0].textContent, /Decide once the turn finishes/);
  assert.equal(byLabel(host, 'Promote b3').disabled, true);
  g.last().on({type: 'backlog', id: 'b3', state: 'promoted'});
  await tick();
  assert.deepEqual(sent, []);
  assert.match(g.last().model.error, /turn finishes/);
});

test('the page tells the card whether a turn runs in the chat', () => {
  const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  const start = renderer.match(/function projectCardStart\(\) \{[\s\S]*?\n\}\n/)[0];
  assert.match(start, /turnRunning: \(sid\) => \(sid === S\.agentSession && \(S\.busy \|\| !!S\.pending\)\) \|\| \[\.\.\.RUNNING\.values\(\)\]\.includes\(sid\)/);
});

test('a seed alone does not keep the backlog card up between gates; it shows when the card is up for another reason', () => {
  let p = project();
  for (const id of ['b1', 'b3', 'b4']) p = call(p, id, 'dropped');
  const between = (q) => view(q, {gate: {kind: 'none'}, version: null, allowedVerdicts: ['cancel'], expectation: {kind: 'run_milestone', id: 'm1'}});
  const seedOnly = between(p);
  assert.equal(seedOnly.backlog.open, 1);
  assert.equal(seedOnly.backlog.seeds.length, 1);
  assert.equal(C.pcModel(C.pcInitial(seedOnly)), null, 'a seed waits for its condition, not for the person now');
  assert.equal(C.pcStore().put('ses-1', seedOnly), false);
  const withOpen = between(call(p, 'b1', 'open'));
  const model = C.pcModel(C.pcInitial(withOpen));
  assert.equal(model.kind, 'backlog');
  assert.match(draw(model).textContent, /b2 · Online play[\s\S]*seed · When: the local game is stable/);
});

test('an agent whose promoted entries carry no citedBy gets no Defer (it takes no backlogStatus edit)', () => {
  const v = view(call(project(), 'b3', 'promoted'));
  const old = {...v, backlog: {...v.backlog, promoted: v.backlog.promoted.map(({citedBy: _c, ...rest}) => rest)}};
  const item = C.pcModel(C.pcInitial(old)).backlog.items.find((i) => i.id === 'b3');
  assert.deepEqual(item.statusActions, []);
  assert.equal(item.cited, null);
  const host = draw(C.pcModel(C.pcInitial(old)));
  assert.equal(/Cited by|No citing tasks/.test(host.textContent), false);
  assert.equal(buttons(host).some((b) => b.textContent === 'Defer'), false);
  assert.ok(C.pcDecision(C.pcInitial(old), 'ses-1', 'edit', {backlog: 'b3', status: 'deferred'}).error);
});

test('a backlog call in flight stays busy across A→B→A, and a second press sends nothing', async () => {
  let release;
  const sent = [];
  const v = view(project());
  const c = controller({read: () => ({supported: true, ok: true, view: v}), decide: () => ({}),
    backlog: (body) => { sent.push(body); return new Promise((r) => { release = r; }); }});
  c.card.follow('ses-1');
  await tick();
  c.last().on({type: 'backlog', id: 'b3', state: 'promoted'});
  await tick();
  c.card.follow('ses-2');
  c.card.follow('ses-1');
  await tick();
  assert.equal(c.last().model.busy, true, 'its buttons stay disabled');
  c.last().on({type: 'backlog', id: 'b1', state: 'dropped'});
  c.last().on({type: 'verdict', verdict: 'approve'});
  await tick();
  assert.equal(sent.length, 1);
  release({supported: true, ok: true, view: view(call(project(), 'b3', 'promoted'))});
  await tick(); await tick();
  assert.equal(c.last().model.busy, false);
  assert.equal(c.last().model.backlog.items.find((i) => i.id === 'b3').state, 'promoted');
});

test('a decided item offers every other call directly, as the TUI\'s backlog', async () => {
  const tui = readFileSync(new URL('../../src/tui/project/project-card-state.ts', import.meta.url), 'utf8');
  assert.match(tui, /item \? stale \|\| item\.state !== action\.state/, 'the TUI offers each state but the item\'s own');
  const sent = [];
  let p = call(call(project(), 'b3', 'promoted'), 'b4', 'dropped');
  const c = controller({read: () => ({supported: true, ok: true, view: view(p)}), decide: () => ({}),
    backlog: (body) => { sent.push(body); p = call(p, body.item, body.state); return {supported: true, ok: true, view: view(p)}; }});
  c.card.follow('ses-1');
  await tick();
  const actions = (id) => c.last().model.backlog.items.find((i) => i.id === id).actions.map(([label]) => label);
  assert.deepEqual(actions('b3'), ['Drop', 'Reopen']);
  assert.deepEqual(actions('b4'), ['Promote', 'Reopen']);
  byLabel(draw(c.last().model, c.last().on), 'Drop b3').fire('click');
  await tick(); await tick();
  byLabel(draw(c.last().model, c.last().on), 'Promote b4').fire('click');
  await tick(); await tick();
  assert.deepEqual(sent, [{sessionId: 'ses-1', item: 'b3', state: 'dropped'}, {sessionId: 'ses-1', item: 'b4', state: 'promoted'}]);
  assert.deepEqual(actions('b3'), ['Promote', 'Reopen']);
});
