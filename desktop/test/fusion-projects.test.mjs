// Issue #109, part 2 (+ #121): the Fusion projects list view
// (renderer/fusion-projects.js): rows grouped by attention zone, most
// recent first, damaged / missing / unsupported folders shown as such
// with their note, forget asks first and never touches files, resume
// opens the chat the agent names.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const F = require('../renderer/fusion-projects.js');

const DAY = 86_400_000;
const NOW = 1_000 * DAY;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ROWS = [
  {folder: '/w/old', status: 'ok', zone: 'idle', name: 'old', gate: 'none', next: 'the director runs milestone m2', updatedAt: NOW - 20 * DAY, spentUsd: 1.234},
  {folder: '/w/gone', status: 'missing', zone: 'problem', problem: 'The folder /w/gone is gone.'},
  {folder: '/w/game', status: 'ok', zone: 'needs-you', name: 'game', gate: 'plan', next: 'you approve the plan', updatedAt: NOW - 2 * 3600_000, spentUsd: null},
  {folder: '/w/new', status: 'ok', zone: 'needs-you', name: 'new', gate: 'brief', next: 'you approve the brief', updatedAt: NOW - 60_000, spentUsd: 0,
    notices: ['An older record of this folder was passed over.']},
  {folder: '/w/broken', status: 'damaged', zone: 'problem', problem: 'project.json is not valid JSON; it was left as it is.'},
  {folder: '/w/next', status: 'unsupported', zone: 'problem', problem: 'project.json is schema version 2.'},
];

test('the zones are the core\'s, in its order', () => {
  const core = readFileSync(new URL('../../src/session/project-attention.ts', import.meta.url), 'utf8');
  const list = core.match(/PROJECT_ATTENTION_ZONES[^=]*=\s*\[([^\]]*)\]/)[1];
  assert.deepEqual(F.FPJ_ZONES, [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
});

test('rows are grouped by zone, what needs you first, the most recent first within a zone; empty zones are left out', () => {
  const groups = F.fpjGroups(ROWS, NOW);
  assert.deepEqual(groups.map((g) => [g.label, g.rows.map((r) => r.folder)]), [
    ['Needs you', ['/w/new', '/w/game']],
    ['Problem', ['/w/gone', '/w/broken', '/w/next']],
    ['Idle', ['/w/old']],
  ]);
  // An older agent sends no zone: an open row reads as in progress, any other as a problem.
  assert.deepEqual(F.fpjGroups([{folder: '/a', status: 'ok', name: 'a', gate: 'none'}, {folder: '/b', status: 'missing'}], NOW).map((g) => g.zone), ['problem', 'in-progress']);
});

test('a healthy row says what waits, what happens next, the last activity and the spend', () => {
  const game = F.fpjRow(ROWS[2], NOW);
  assert.equal(game.name, 'game');
  assert.equal(game.canResume, true);
  assert.deepEqual(game.lines, ['Waiting on you: the plan', 'Next: you approve the plan', 'Last activity: 2 hours ago', 'Spend: no recorded runs']);
  assert.deepEqual(F.fpjRow(ROWS[0], NOW).lines, ['Nothing waits for you', 'Next: the director runs milestone m2', 'Last activity: 20 days ago', 'Spend: $1.23']);
  assert.deepEqual(F.fpjRow(ROWS[3], NOW).notes, ['An older record of this folder was passed over.']);
  assert.equal(F.fpjRow({...ROWS[2], gate: 'milestone m2'}, NOW).lines[0], 'Waiting on you: milestone m2');
});

test('a missing, damaged or unsupported folder is shown as such, with its note and what to do; it cannot be resumed', () => {
  const [gone, broken, next] = [ROWS[1], ROWS[4], ROWS[5]].map((r) => F.fpjRow(r, NOW));
  assert.deepEqual([gone.badge, broken.badge, next.badge], ['Folder missing', 'Damaged', 'Unsupported']);
  assert.equal(gone.name, 'gone', 'named after its folder');
  assert.deepEqual(broken.notes, ['project.json is not valid JSON; it was left as it is.']);
  assert.match(gone.todo, /Forget/);
  assert.match(broken.todo, /project\.json/);
  assert.match(next.todo, /Update Atomic Agent/);
  assert.equal(gone.canResume || broken.canResume || next.canResume, false);
  assert.equal(gone.canForget, true);
});

test('the sheet draws every row with its actions; model text is escaped; an empty list and a damaged list say so', () => {
  const html = F.fpjBodyHTML({rows: [...ROWS, {folder: '/w/<x>', status: 'ok', zone: 'done', name: '<img onerror=1>', gate: 'none', next: 'nothing', updatedAt: NOW}]}, NOW, esc);
  assert.ok(html.includes('&lt;img onerror=1&gt;') && !html.includes('<img onerror'));
  for (const g of ['Needs you', 'Problem', 'Idle', 'Done']) assert.ok(html.includes('>' + g + '<'), g);
  assert.equal((html.match(/data-act="fpjresume:/g) || []).length, 4, 'resume only on rows that open');
  assert.equal((html.match(/data-act="fpjforgetask:/g) || []).length, 7, 'forget on every row');
  assert.ok(html.includes('Folder missing') && html.includes('project.json is not valid JSON'));
  assert.match(F.fpjBodyHTML({rows: []}, NOW, esc), /No Fusion projects yet/);
  assert.match(F.fpjBodyHTML({rows: [], registryProblem: 'registry.json is not valid JSON'}, NOW, esc), /registry\.json is not valid JSON/);
  assert.match(F.fpjBodyHTML({rows: [], unsupported: true}, NOW, esc), /update it/i);
  assert.match(F.fpjBodyHTML({rows: [], loading: true}, NOW, esc), /Loading/);
});

test('forget asks first and says the files stay; resume opens the chat the agent names or says why not', () => {
  const ask = F.fpjForgetAlert(F.fpjRow(ROWS[2], NOW));
  assert.equal(ask.title, 'Forget the Fusion project “game”?');
  assert.match(ask.msg, /\/w\/game/);
  assert.match(ask.msg, /files are not touched/);
  assert.equal(ask.ok, 'Forget');
  assert.equal(ask.act, 'fpjforget:');
  assert.deepEqual(F.fpjResumeOutcome({supported: true, ok: true, sessionId: 's-9', created: true, name: 'game', view: null}), {sessionId: 's-9', created: true});
  assert.deepEqual(F.fpjResumeOutcome({supported: true, ok: false, status: 422, code: 'project-unavailable', error: 'damaged'}), {error: 'damaged'});
  assert.match(F.fpjResumeOutcome({supported: false}).error, /update it/i);
  assert.deepEqual(F.fpjListOutcome({supported: true, ok: true, projects: ROWS, registryProblem: null}), {rows: ROWS, registryProblem: null});
  assert.deepEqual(F.fpjListOutcome({supported: false}), {rows: [], unsupported: true});
  assert.deepEqual(F.fpjListOutcome({supported: true, ok: false, status: 0, error: 'down'}), {rows: [], error: 'down'});
});

test('the list opens from the Projects header in the sidebar, and its script is loaded before renderer.js', () => {
  const projects = readFileSync(new URL('../renderer/chat-projects.js', import.meta.url), 'utf8');
  assert.match(projects, /data-act="fpjopen:"/);
  const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = (name) => index.indexOf('<script src="' + name + '"></script>');
  assert.ok(at('fusion-projects.js') > 0 && at('fusion-projects.js') < at('renderer.js'));
  const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(renderer, /S\.overlay === 'fprojects'\) html \+= fusionProjectsHTML\(\)/);
  assert.match(renderer, /fpjAct\(k, v\)/);
});
