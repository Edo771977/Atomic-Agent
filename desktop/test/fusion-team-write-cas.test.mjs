// Issue #74 item 5: agent:fusionTeamWrite (fusion-team-write.ts) plans the
// team on the file and the legs bookkeeping read inside the config lock,
// and on a live agent checks the file's hash again right before the PATCH:
// a write that landed in between is planned on again, never overwritten.
// Built output. Run: npm run build && node --test test/fusion-team-write-cas.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { writeFusionTeam } = require('../out/main/fusion-team-write.js');

const cfg = (reviewers) => ({
  llm: {
    providers: [{id: 'a', kind: 'openai', defaultChatModel: 'm1'}, {id: 'b', kind: 'openai', defaultChatModel: 'm2'}],
    runMode: {mode: 'fusion', fusion: {orchestratorProvider: 'a', team: {directors: ['a:m1'], reviewers}}},
  },
});

function deps(reads, over = {}) {
  let inLock = false;
  const seen = {patches: [], legsReadInLock: [], reads: 0, rewrites: 0};
  const d = {
    live: async () => true,
    withLock: async (hold) => { inLock = true; try { return await hold(); } finally { inLock = false; } },
    readWithSha: async () => { const r = reads[Math.min(seen.reads, reads.length - 1)]; seen.reads++; return {ok: true, config: structuredClone(r.config), sha256: r.sha}; },
    patchTeam: async (team) => { seen.patches.push(structuredClone(team)); },
    rewrite: async (plan) => { seen.rewrites++; let verdict; await d.withLock(async () => { verdict = plan(structuredClone(reads[0].config)); }); return {ok: true, changed: verdict.write, verdict}; },
    readLegs: () => { seen.legsReadInLock.push(inLock); return {}; },
    writeLegs: () => {},
    changedElsewhere: 'changed elsewhere',
    ...over,
  };
  return {d, seen};
}

test('a write that landed between the read and the PATCH is planned on again, not overwritten', async () => {
  const before = {config: cfg(['b:m2']), sha: '1'.repeat(64)};
  // Someone else added a:m1 as a reviewer meanwhile.
  const after = {config: cfg(['b:m2', 'a:m1']), sha: '2'.repeat(64)};
  const {d, seen} = deps([before, after, after, after]);
  const res = await writeFusionTeam({op: 'addReviewer', ref: 'b:x'}, d);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(seen.patches.length, 1);
  assert.deepEqual(seen.patches[0].reviewers, ['b:m2', 'a:m1', 'b:x'], 'the other writer\'s reviewer is kept');
});

test('a file that keeps moving is not patched, and says so', async () => {
  const reads = Array.from({length: 10}, (_, i) => ({config: cfg(['b:m2']), sha: String(i).repeat(64)}));
  const {d, seen} = deps(reads);
  const res = await writeFusionTeam({op: 'addReviewer', ref: 'b:x'}, d);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'changed elsewhere');
  assert.equal(seen.patches.length, 0);
});

test('an agent that gives no hash is patched the old way', async () => {
  const {d, seen} = deps([{config: cfg([]), sha: null}]);
  const res = await writeFusionTeam({op: 'addReviewer', ref: 'b:x'}, d);
  assert.deepEqual(res, {ok: true, changed: true, live: true});
  assert.deepEqual(seen.patches[0].reviewers, ['b:x']);
});

test('the legs bookkeeping is read inside the config lock, live or not', async () => {
  const live = deps([{config: cfg([]), sha: 'a'.repeat(64)}]);
  await writeFusionTeam({op: 'followLegs'}, live.d);
  assert.ok(live.seen.legsReadInLock.length > 0 && live.seen.legsReadInLock.every(Boolean), JSON.stringify(live.seen.legsReadInLock));
  const file = deps([{config: cfg([]), sha: 'a'.repeat(64)}], {live: async () => false});
  await writeFusionTeam({op: 'followLegs'}, file.d);
  assert.equal(file.seen.rewrites, 1);
  assert.ok(file.seen.legsReadInLock.length > 0 && file.seen.legsReadInLock.every(Boolean), JSON.stringify(file.seen.legsReadInLock));
});

test('a bad payload is refused before anything is read', async () => {
  const {d, seen} = deps([{config: cfg([]), sha: null}]);
  assert.equal((await writeFusionTeam({op: 'nope'}, d)).ok, false);
  assert.equal((await writeFusionTeam({op: 'addReviewer'}, d)).error, 'ref is required');
  assert.equal(seen.reads, 0);
});
