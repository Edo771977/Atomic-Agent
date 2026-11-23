import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {createProjectCard, pcLessonSection} = require('../renderer/project-card.js');
const {parseProjectLessonIpc} = require('../out/main/project-ipc.js');
const tick = () => new Promise(setImmediate);
const fingerprint = '1'.repeat(64);
const changed = '2'.repeat(64);
const view = {schema: 1, gate: {kind: 'none'}, sessionId: 's1', version: 1};
const row = {
  id: 'storage', hash: fingerprint, hasChoice: false,
  lesson: {declaredStatus: 'active', source: 'person', title: 'Keep storage local', touches: ['src'], always: true,
    sections: {decided: ' abcdef', triedAndRuledOut: '', watchOut: ''}},
  status: {effectiveStatus: 'unapproved', personState: null},
  promptEnds: {decided: {planning: 2, standard: 4}},
};

test('lesson detail preserves full text across both prompt cuts', () => {
  assert.deepEqual(pcLessonSection(row, 'decided', 5), [
    {text: ' a'}, {mark: 'Model sees only up to here (shared planning budget).'},
    {text: 'bc'}, {mark: 'Standard 5-character limit ends here.'}, {text: 'def'},
  ]);
});

test('approval requires the visible end of the displayed revision, and stale replies replace the detail', async () => {
  const calls = [];
  let model, act, running = false, privateChat = false;
  const card = createProjectCard({
    api: {
      read: () => ({ok: true, view}),
      lessons: () => privateChat
        ? {ok: false, panel: {rows: [], blocked: 'Project lessons are unavailable in incognito chats.'}}
        : {ok: true, panel: {rows: [row]}},
      lessonChoice: body => {
        calls.push(body);
        return {ok: false, code: 'stale-view', error: 'The lesson has changed.', panel: {rows: [{...row, hash: changed}]}};
      },
    },
    draw: (m, a) => { model = m; act = a; }, onContinue() {},
    turnRunning: () => running,
  });
  card.follow('s1');
  await tick();
  assert.equal(card.canBrowseLessons(), true);
  card.openLessons();
  await tick();
  act({type: 'lesson-read', id: row.id});
  assert.equal(model.lessonPanel.row.hash, fingerprint);
  await act({type: 'lesson-choice', action: 'approve'});
  assert.deepEqual(calls, []);
  act({type: 'lesson-end', hash: fingerprint});
  running = true;
  await act({type: 'lesson-choice', action: 'approve'});
  assert.deepEqual(calls, []);
  running = false;
  await act({type: 'lesson-choice', action: 'approve'});
  assert.deepEqual(calls, [{session: 's1', lesson: 'storage', action: 'approve', fingerprint}]);
  assert.equal(model.lessonPanel.row.hash, changed);
  assert.equal(model.lessonPanel.seen, false);
  privateChat = true;
  await act({type: 'lesson-refresh'});
  assert.match(model.lessonPanel.blocked, /incognito/);
  assert.equal(model.lessonPanel.row, undefined);
  await act({type: 'lesson-choice', action: 'retire'});
  assert.equal(calls.length, 1);
});

test('proposals cannot be approved and orphaned choices can only be reopened', async () => {
  const calls = [];
  let act;
  const proposal = {...row, lesson: {...row.lesson, declaredStatus: 'proposed'}};
  const orphan = {id: 'old', hash: changed, orphanedChoice: 'retired'};
  const card = createProjectCard({
    api: {read: () => ({ok: true, view}), lessons: () => ({ok: true, panel: {rows: [proposal, orphan]}}),
      lessonChoice: body => { calls.push(body); return {ok: true, panel: {rows: [proposal]}}; }},
    draw: (_model, action) => { act = action; }, onContinue() {},
  });
  card.follow('s1');
  await tick();
  card.openLessons();
  await tick();
  act({type: 'lesson-read', id: proposal.id});
  act({type: 'lesson-end', hash: proposal.hash});
  await act({type: 'lesson-choice', action: 'approve'});
  act({type: 'lesson-read', id: orphan.id});
  await act({type: 'lesson-choice', action: 'retire'});
  await act({type: 'lesson-choice', action: 'reopen'});
  assert.deepEqual(calls, [{session: 's1', lesson: 'old', action: 'reopen', fingerprint: changed, orphaned: true}]);
});

test('the IPC rebuilds a fingerprinted choice before sending it', () => {
  const body = {session: 's1', lesson: 'storage', action: 'reopen', fingerprint, orphaned: true};
  assert.deepEqual(parseProjectLessonIpc({...body, extra: true}), {ok: true, body});
  for (const bad of [{fingerprint: '123'}, {lesson: '../x'}, {action: 'approve'}]) {
    assert.equal(parseProjectLessonIpc({...body, ...bad}).ok, false);
  }
});

for (const [code, expected, blocked] of [
  ['person-auth-required', /start atag serve with an API key/i, true],
  ['busy', /another process.*try again/i, false],
  ['io', /could not save.*refresh/i, false],
]) {
  test('the lesson panel explains ' + code + ' and keeps the displayed lesson', async () => {
    let model, act, writes = 0;
    const card = createProjectCard({
      api: {read: () => ({ok: true, view}), lessons: () => ({ok: true, panel: {rows: [row]}}),
        lessonChoice: () => { writes++; return {ok: false, code, error: 'server refusal'}; }},
      draw: (m, a) => { model = m; act = a; }, onContinue() {},
    });
    card.follow('s1');
    await tick();
    await card.openLessons();
    act({type: 'lesson-read', id: row.id});
    await act({type: 'lesson-choice', action: 'retire'});
    assert.match(model.lessonPanel.error, expected);
    assert.equal(model.lessonPanel.row.hash, fingerprint);
    assert.equal(Boolean(model.lessonPanel.blocked), blocked);
    await act({type: 'lesson-choice', action: 'retire'});
    assert.equal(writes, blocked ? 1 : 2);
  });
}
