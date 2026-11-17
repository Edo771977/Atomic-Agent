// Phone push of an unattended turn's note (ATO-1129) against the chat's
// folder constraint (issue #33): the push goes only where the agent says
// the chat's content may go to a channel, never carries the error text of
// a restricted chat, and fails closed. Pure half of main
// (main/turn-notify.ts, from the built output: npm run build first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../out/main/turn-notify.js');

const LEAK = 'This session read files from /home/me/clients/acme-merger, which is restricted to: local-llama';
const failed = {sessionId: 's-1', outcome: 'failed', steps: 2, durationMs: 40_000, error: LEAK, workingDirName: 'acme-merger'};

test('a restricted chat without channels egress sends nothing to the phone', () => {
  const answer = {status: 200, body: {restriction: {label: 'restricted to: local-llama', folder: '/x', readFrom: [], allowedProviders: ['local-llama']}, channelsAllowed: false}};
  assert.equal(M.turnPushNote(failed, answer), null);
});

test('a restricted chat that allows channels gets the note without the error text or the folder', () => {
  const answer = {status: 200, body: {restriction: {label: 'restricted to: local-llama', folder: '/x', readFrom: [], allowedProviders: ['local-llama']}, channelsAllowed: true}};
  const note = M.turnPushNote(failed, answer);
  assert.equal(note.title, 'Turn failed');
  assert.ok(!note.body.includes('acme-merger'), note.body);
  assert.ok(!note.body.includes('restricted'), note.body);
  assert.equal(note.body, 'open Atomic Agent to see why · 2 tool calls · 40s');
});

test('an unrestricted chat gets the whole note, error included', () => {
  const note = M.turnPushNote({...failed, error: 'model server went away'}, {status: 200, body: {restriction: null, channelsAllowed: true}});
  assert.match(note.body, /^model server went away · 2 tool calls/);
});

test('fail closed: no session, no answer, an error status, an older agent without channelsAllowed', () => {
  const restricted = {restriction: {label: 'r', folder: '/x', readFrom: [], allowedProviders: []}};
  assert.equal(M.turnPushNote({...failed, sessionId: null}, {status: 200, body: {restriction: null, channelsAllowed: true}}), null);
  assert.equal(M.turnPushNote(failed, null), null);
  assert.equal(M.turnPushNote(failed, {status: 404, body: null}), null);
  assert.equal(M.turnPushNote(failed, {status: 500, body: {restriction: null, channelsAllowed: true}}), null);
  assert.equal(M.turnPushNote(failed, {status: 200, body: restricted}), null);
  assert.equal(M.turnPushNote(failed, {status: 200, body: 'nope'}), null);
  // A live taint: no stored restriction, but the effective policy refuses channels.
  assert.equal(M.turnPushNote(failed, {status: 200, body: {restriction: null, channelsAllowed: false}}), null);
});

test('the notifier hands show the turn\'s session and the chat\'s own folder name', async () => {
  const shown = [];
  let t = 0;
  const asked = [];
  const n = new M.TurnNotifier({
    now: () => t,
    isFocused: () => false,
    readConfig: async () => ({enabled: true, minDurationMs: 0}),
    workingDirName: async (sid) => { asked.push(sid); return sid === 's-9' ? 'acme-merger' : 'default-dir'; },
    show: (note, turn) => shown.push({note, turn}),
  });
  n.begin('t1');
  n.observe({turnId: 't1', kind: 'session_id', payload: {sessionId: 's-9'}});
  t = 5_000;
  n.observe({turnId: 't1', kind: 'error', error: LEAK});
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(shown.length, 1);
  assert.deepEqual(asked, ['s-9']);
  assert.equal(shown[0].turn.sessionId, 's-9');
  assert.equal(shown[0].turn.error, LEAK);
  assert.equal(shown[0].turn.workingDirName, 'acme-merger');
  assert.match(shown[0].note.body, /acme-merger$/);
});

test('the notifier also learns the session from the caller (a known chat sends no session_id frame first)', async () => {
  const shown = [];
  const n = new M.TurnNotifier({
    isFocused: () => false,
    readConfig: async () => ({enabled: true, minDurationMs: 0}),
    workingDirName: () => undefined,
    sessionOf: (turnId) => (turnId === 't2' ? 's-2' : null),
    show: (note, turn) => shown.push(turn),
  });
  n.begin('t2');
  n.observe({turnId: 't2', kind: 'error', error: 'x'});
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(shown[0].sessionId, 's-2');
});
