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
