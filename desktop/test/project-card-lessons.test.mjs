import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadCore } from './core-ts.mjs';

const require = createRequire(import.meta.url);
const C = require('../renderer/project-card.js');
const { parseProjectDecisionIpc } = require('../out/main/project-ipc.js');
const core = (path) => loadCore(new URL('../../src/' + path + '.ts', import.meta.url), ['node:vm', 'node:crypto']);
const CORE = core('session/session-project');
const { parseProjectDecision } = core('session/project-decision-parse');
const { evaluatePlanChecks, planCheckHint } = core('tools/fusion/plan-checks');

const title = 'Storage <img src=x onerror=alert(1)>';
const lesson = (id, title) => ({id, title, always: true, touches: [], hash: 'a'.repeat(64)});

function project() {
  let p;
  const take = (r) => { assert.ok(r.ok, JSON.stringify(r.error)); p = r.project; };
  take(CORE.applyProjectUpdate(undefined, {kind: 'brief', brief: {
    what: 'A project', users: 'A team', how: 'A document', successCriteria: ['Readable'],
  }}, 1));
  take(CORE.applyProjectDecision(p, {gate: p.gate, version: CORE.gateVersion(p), verdict: 'approve'}, {now: 2}));
  take(CORE.applyProjectUpdate(p, {
    kind: 'plan', milestones: [{id: 'm1', title: 'Draft', kind: 'draft'}],
    rows: [{taskId: 't1', title: 'Draft', milestoneId: 'm1', worker: 'openrouter:w',
      reviewer: null, reason: 'preset', basis: 'preset', samples: 0, estCostUsd: 0, estMs: 100,
      lessons: ['format']}], detail: 'full',
  }, 3));
  p[CORE.currentProjectLessons] = {
    active: [lesson('format', 'Format'), lesson('local-storage', title)],
    stale: ['old-lesson'], taskPaths: () => [], matches: () => false,
  };
  return p;
}

function view(p) {
  return {
    schema: 1, sessionId: 'ses-1', gate: p.gate, version: CORE.gateVersion(p),
    allowedVerdicts: CORE.allowedProjectVerdicts(p.gate), plan: p.plan, milestones: p.milestones,
    lessonCoverage: CORE.planLessonsOf(p, p.plan.rows),
    hints: evaluatePlanChecks(p.plan.rows, p.approvedCriteria, CORE.planCheckData(p, p.plan)).map(planCheckHint),
  };
}

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
test('IPC accepts only valid lesson status maps on plan edits', () => {
  const valid = {session: 'ses-1', gate: {kind: 'plan'}, version: 2, verdict: 'edit',
    edits: {lessonStatus: {'local-storage': 'deferred', ['a'.repeat(64)]: 'active'}}};
  assert.deepEqual(parseProjectDecisionIpc(valid), {ok: true, body: valid});
  assert.equal(typeof parseProjectDecision(valid), 'object');
  for (const lessonStatus of [null, [], 'local-storage', {}, {Bad: 'active'}, {'a b': 'active'},
    {['a'.repeat(65)]: 'active'}, {'local-storage': 'informational'},
    Object.fromEntries(Array.from({length: 129}, (_, i) => ['lesson-' + i, 'active']))]) {
    assert.equal(parseProjectDecisionIpc({...valid, edits: {lessonStatus}}).ok, false);
  }
  for (const kind of ['brief', 'milestone', 'none']) {
    assert.equal(parseProjectDecisionIpc({...valid, gate: {kind, id: 'm1'}}).ok, false);
  }
  assert.equal(parseProjectDecisionIpc({...valid, verdict: 'approve'}).ok, false);
});

test('the plan shows cited and uncited lessons as text, and stale lessons under Plan checks', () => {
  const v = view(project());
  const host = draw(C.pcModel(C.pcInitial(v)));
  const section = host.findAll((el) => el.getAttribute('aria-label') === 'Lessons')[0];
  assert.ok(section);
  assert.match(section.textContent, /format · Format.*active · Cited by: t1/);
  assert.ok(section.textContent.includes(title));
  assert.match(section.textContent, /local-storage.*active · No citing tasks/);
  assert.equal(section.findAll((el) => el.tagName === 'IMG').length, 0);
  const checks = host.findAll((el) => el.className === 'pc-assessment')[0];
  assert.match(checks.textContent, /Plan checks.*lesson-coverage · warn.*Approved lesson old-lesson changed or was removed/);
  assert.match(checks.textContent, /lesson-coverage · fail/);
  for (const other of [{...v, lessonCoverage: undefined}, {...v, gate: {kind: 'brief'}}]) {
    assert.equal(draw(C.pcModel(C.pcInitial(other))).findAll((el) => el.getAttribute('aria-label') === 'Lessons').length, 0);
  }
});

test('Defer and Reactivate send the shown plan version and update real lesson coverage', async () => {
  let p = project();
  let running = false;
  let latest;
  const sent = [];
  const card = C.createProjectCard({
    turnRunning: () => running,
    api: {
      read: async () => ({supported: true, ok: true, view: view(p)}),
      decide: async (body) => {
        sent.push(body);
        const ipc = parseProjectDecisionIpc(body);
        if (!ipc.ok) return ipc;
        const r = CORE.applyProjectDecision(p, parseProjectDecision(ipc.body), {now: 4});
        if (!r.ok) return r;
        p = r.project;
        return {supported: true, ok: true, view: view(p)};
      },
    },
    draw: (model, on) => { latest = {model, on}; },
    onContinue: () => true,
  });
  const redraw = () => draw(latest.model, latest.on);
  const version = CORE.gateVersion(p);
  card.follow('ses-1');
  await tick();
  const previous = byLabel(redraw(), 'Defer local-storage');
  assert.ok(previous);
  running = true;
  card.follow('ses-1');
  assert.equal(byLabel(redraw(), 'Defer local-storage').disabled, true);
  previous.fire('click');
  await tick();
  assert.deepEqual(sent, []);

  running = false;
  card.follow('ses-1');
  byLabel(redraw(), 'Defer local-storage').fire('click');
  await tick();
  assert.deepEqual(sent[0], {session: 'ses-1', gate: {kind: 'plan'}, version, verdict: 'edit',
    edits: {lessonStatus: {'local-storage': 'deferred'}}});
  assert.match(redraw().textContent, /local-storage.*deferred · No citing tasks/);
  assert.equal(latest.model.checks.some((c) => c.dimension === 'lesson-coverage' && c.verdict === 'pass'), true);
  assert.equal(latest.model.checks.some((c) => c.dimension === 'lesson-coverage' && c.verdict === 'fail'), false);

  running = true;
  card.follow('ses-1');
  assert.equal(byLabel(redraw(), 'Reactivate local-storage').disabled, true);
  running = false;
  card.follow('ses-1');
  byLabel(redraw(), 'Reactivate local-storage').fire('click');
  await tick();
  assert.deepEqual(sent[1], {session: 'ses-1', gate: {kind: 'plan'}, version: version + 1, verdict: 'edit',
    edits: {lessonStatus: {'local-storage': 'active'}}});
  assert.equal(latest.model.checks.some((c) => c.dimension === 'lesson-coverage' && c.verdict === 'fail'), true);
});

test('the review panel draws all author fields as text and exposes invisible code points', () => {
  const hash = '1'.repeat(64);
  const hidden = '\u202E\u{E0061}\u0008';
  const text = '<img src=x>' + hidden;
  const row = {
    id: 'storage', hash, hasChoice: false,
    lesson: {title: text, source: 'director' + hidden, from: text, touches: [text], always: true,
      declaredStatus: 'active', sections: {decided: text, triedAndRuledOut: '', watchOut: ''}},
    status: {effectiveStatus: 'unapproved', personState: null},
  };
  for (const selected of [undefined, row]) {
    const host = draw({kind: 'lesson-panel', lessonPanel: {panel: {rows: [row]}, row: selected}});
    assert.match(host.textContent, /<img src=x>\\u\{202E\}\\u\{E0061\}\\u\{0008\}/);
    assert.equal(host.textContent.includes(hidden[0]), false);
    assert.equal(host.findAll((el) => el.tagName === 'IMG').length, 0);
  }
});
