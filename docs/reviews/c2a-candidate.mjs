// Run against a disposable checkout carrying 317838445 and the C2-only
// adaptation of dc5a4b980. Assertions describe the required safe behavior.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(process.env.C2_CANDIDATE_ROOT ?? process.cwd());
const configDir = mkdtempSync(join(tmpdir(), 'c2a-audit-config-'));
process.env.ATOMIC_AGENT_STATE_DIR = configDir;
after(() => rmSync(configDir, { recursive: true, force: true }));
const load = name => import(pathToFileURL(join(root, name)).href);
const { createEmptySessionState, incrementTurnCount, recordTurn } = await load('src/session/session-state.ts');
const { planLastTurnRollback, planRestorePreviousReply } = await load('src/session/session-truncate.ts');
const { normalizeSessionState } = await load('src/session/normalize-session-state.ts');
const { SessionStore } = await load('src/session/session-store.ts');
const { Database } = await load('src/native/load-better-sqlite3.ts');
const { createHttpServer } = await load('src/http/http-server.ts');
const { buildRouteTable } = await load('src/http/route-table.ts');
const { ROUTE_SCOPES } = await load('src/http/http-scopes.ts');
const { hashHttpToken } = await load('src/http/http-token-store.ts');
const { TurnController } = await load('src/runtime/turn-controller.ts');
const { extendCloudContext } = await load('src/session/cloud-context.ts');
const { renderChatMarkdown } = await load('src/session/chat-export.ts');
const fresh = () => createEmptySessionState({ id: 'audit-chat', workingDir: root });
const turn = (state, question, answer) => ({ ...incrementTurnCount(recordTurn(recordTurn(state,
  { kind: 'user', text: question, at: 10 }), { kind: 'assistant_reply', text: answer, at: 20 })), status: 'completed' });
function rollback(state) { const plan = planLastTurnRollback(state); assert.equal(plan.ok, true); return plan.state; }
function kept(reply = { kind: 'assistant_reply', text: 'old answer', at: 20 }) {
  return { prompt: { kind: 'user', text: 'question', at: 10 }, priorQuestions: 0,
    replies: [{ reply, replacedAt: 30 }] };
}

test('C2a: each route has the fork permission, including admin restore', () => {
  assert.equal(ROUTE_SCOPES['GET /api/sessions/{id}/previous-replies'], 'read');
  assert.equal(ROUTE_SCOPES['POST /api/sessions/{id}/restore-previous-reply'],
    ROUTE_SCOPES['POST /api/sessions/{id}/rollback-last-turn']);
});
test('C2a: one archived answer cannot retain two MiB', () => {
  const next = rollback(turn(fresh(), 'question', 'x'.repeat(2 * 1024 * 1024)));
  assert.ok(Buffer.byteLength(JSON.stringify(next.previousReplies ?? null)) < 2 * 1024 * 1024,
    'the complete two-MiB answer was retained without a byte budget');
});
test('C2a: ten archived answers have a session-wide byte budget', () => {
  let state = fresh();
  for (let i = 0; i < 12; i++) state = rollback(turn(state, 'question', 'x'.repeat(256 * 1024)));
  assert.ok(Buffer.byteLength(JSON.stringify(state.previousReplies)) < 2 * 1024 * 1024,
    'the count cap still retains more than two MiB for one session');
});
for (const [label, mutate] of [
  ['missing reply timestamp', x => { delete x.replies[0].reply.at; }],
  ['object reasoning', x => { x.replies[0].reply.reasoning = { unvalidated: 'payload' }; }],
  ['tool-bearing reply', x => { x.replies[0].reply.toolsRan = true; }],
  ['non-finite replacement timestamp', x => { x.replies[0].replacedAt = Infinity; }],
  ['steered prompt', x => { x.prompt.steered = true; }],
]) test(`C2a: normalization drops ${label}`, () => {
  const record = kept(); mutate(record);
  assert.equal(normalizeSessionState({ ...fresh(), previousReplies: record }).previousReplies, undefined);
});
test('C2a: normalization does not retain unrecognized nested archive fields', () => {
  const record = kept(); record.replies[0].reply.extra = 'x'.repeat(2 * 1024 * 1024);
  const normalized = normalizeSessionState({ ...fresh(), previousReplies: record });
  assert.ok(Buffer.byteLength(JSON.stringify(normalized.previousReplies ?? null)) < 2 * 1024 * 1024);
});
test('C2a: incognito does not add archived answers to the database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2a-private-')); const file = join(dir, 'sessions.sqlite');
  const store = new SessionStore({ dbFile: file });
  try {
    const state = { ...fresh(), incognito: store.newIncognitoMark() };
    store.save(rollback(turn(state, 'question', 'PRIVATE-ARCHIVED-ANSWER')));
    const db = new Database(file, { readonly: true });
    try {
      const row = db.prepare('SELECT payload FROM sessions WHERE id = ?').get(state.id);
      assert.equal(JSON.parse(row.payload).previousReplies, undefined, 'incognito archive is on disk');
    } finally { db.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('C2a: restore acquires the turn controller rather than only checking isBusy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2a-lock-')); const store = new SessionStore({ dbFile: join(dir, 'sessions.sqlite') });
  const controller = new TurnController(); let acquisitions = 0;
  const enqueue = controller.enqueue.bind(controller);
  controller.enqueue = submission => { acquisitions++; return enqueue(submission); };
  store.save(rollback(turn(fresh(), 'question', 'old answer')));
  const runtime = { sessionStore: store, turnController: controller, cancelSessionCompaction() {} };
  const server = await createHttpServer({ runtime, host: '127.0.0.1', port: 0, apiKey: 'audit-owner', routes: buildRouteTable() });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/sessions/audit-chat/restore-previous-reply`,
      { method: 'POST', headers: { authorization: 'Bearer audit-owner', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200);
    assert.ok(acquisitions > 0, 'successful mutation never acquired the per-session turn lock');
  } finally { await server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('C2a control: private and unknown IDs are indistinguishable for named tokens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2a-visibility-')); const store = new SessionStore({ dbFile: join(dir, 'sessions.sqlite') });
  const privateState = { ...fresh(), incognito: store.newIncognitoMark() };
  store.save(rollback(turn(privateState, 'question', 'private answer')));
  const runtime = { sessionStore: store, turnController: new TurnController(), cancelSessionCompaction() {} };
  const server = await createHttpServer({ runtime, host: '127.0.0.1', port: 0, apiKey: 'audit-owner', routes: buildRouteTable(),
    namedTokens: () => [{ name: 'audit', role: 'admin', sha256: hashHttpToken('audit-named'), createdAt: '' }] });
  try {
    for (const [method, suffix] of [['GET', 'previous-replies'], ['POST', 'restore-previous-reply']]) {
      const invoke = async id => {
        const r = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${id}/${suffix}`, { method,
          headers: { authorization: 'Bearer audit-named', 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
        return { status: r.status, body: await r.text() };
      };
      const response = await invoke(privateState.id);
      assert.equal(response.status, 404); assert.deepEqual(response, await invoke('unknown-chat'));
    }
  } finally { await server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('C2a control: restore preserves prior cloud journal bytes and excludes archived alternatives', () => {
  let state = turn(fresh(), 'first question', 'first answer');
  state.cloudContext = extendCloudContext(undefined, state.turns, new Map([['instructions', 'stable instruction bytes']]));
  const prefix = JSON.stringify(state.cloudContext.entries);
  state = turn(state, 'question', 'ARCHIVED-ALTERNATIVE');
  const cut = rollback(state); const newer = turn(cut, 'question', 'current answer');
  const restored = planRestorePreviousReply(newer, 0); assert.equal(restored.ok, true);
  assert.equal(JSON.stringify(restored.state.cloudContext.entries), prefix);
  assert.ok(!renderChatMarkdown(newer).includes('ARCHIVED-ALTERNATIVE'));
  assert.ok(!JSON.stringify(extendCloudContext(newer.cloudContext, newer.turns, new Map())).includes('ARCHIVED-ALTERNATIVE'));
  assert.equal(restored.text, 'ARCHIVED-ALTERNATIVE');
});
test('C2a control: deletion removes the session and its archived answer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2a-delete-')); const store = new SessionStore({ dbFile: join(dir, 'sessions.sqlite') });
  try { const state = rollback(turn(fresh(), 'question', 'old answer')); store.save(state); store.delete(state.id); assert.equal(store.load(state.id), null); }
  finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
