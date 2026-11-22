// Issue #39, desktop half: GET /api/project, POST /api/project/decision and
// X-Atomic-Project through AgentClient, and the IPC validation in
// main/project-ipc.ts. Built output.
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentClient } = require('../out/main/agent-client.js');
const { parseProjectDecisionIpc, parseProjectSessionIpc, MAX_PROJECT_NOTE_CHARS } = require('../out/main/project-ipc.js');

function view(over = {}) {
  return Object.assign({
    schema: 1, sessionId: 'ses-1', gate: {kind: 'plan'}, version: 3,
    allowedVerdicts: ['approve', 'edit', 'cheaper', 'quality', 'cancel'],
    expectation: {kind: 'await_person', gate: {kind: 'plan'}}, cancelled: false,
    brief: null, plan: null, milestones: [], violations: [],
  }, over);
}

/** An agent stand-in: `answer(req, body)` → [status, json | sse-string, headers?]. */
async function standIn(answer) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({method: req.method, url: req.url, body, headers: req.headers});
      const [code, out, headers] = answer(req, body);
      if (typeof out === 'string' && headers && headers['content-type'] === 'text/event-stream') {
        res.writeHead(code, headers);
        res.end(out);
        return;
      }
      res.writeHead(code, {'content-type': 'application/json'});
      res.end(typeof out === 'string' ? out : JSON.stringify(out));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new AgentClient(process.cwd());
  client.port = server.address().port;
  client.token = 't0ken';
  return {client, seen, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); })};
}

const sse = (frames) => frames.map(([event, data]) => (event ? `event: ${event}\n` : '') + `data: ${JSON.stringify(data)}\n\n`).join('');
const SSE = {'content-type': 'text/event-stream'};

/* ---------------- (c) X-Atomic-Project ---------------- */

function chatAgent({project}) {
  const v = view();
  return (r) => {
    if (r.url.startsWith('/api/capabilities')) return [200, {agent: project === undefined ? {} : {project}}];
    if (r.url === '/v1/chat/completions') {
      return [200, sse([
        ['session_id', {session_id: 'ses-1'}],
        ['project_gate', {object: 'atomic.project_gate', session_id: 'ses-1', view: v}],
        [null, {choices: [{delta: {content: 'ok'}}]}],
      ]) + 'data: [DONE]\n\n', SSE];
    }
    return [404, {error: {message: 'No route'}}];
  };
}

test('X-Atomic-Project: 1 goes on a chat only when the agent reports agent.project true', async () => {
  for (const [project, want] of [[true, '1'], [false, undefined], [undefined, undefined]]) {
    const s = await standIn(chatAgent({project}));
    try {
      await s.client.chat('t1', [{role: 'user', content: 'hi'}], 'ses-1');
      await s.client.chat('t2', [{role: 'user', content: 'again'}], 'ses-1');
      const chats = s.seen.filter((r) => r.url === '/v1/chat/completions');
      assert.equal(chats.length, 2);
      for (const c of chats) {
        assert.equal(c.headers['x-atomic-project'], want, `agent.project=${project}`);
        assert.equal(c.headers['x-atomic-extensions'], '1');
      }
      // One capabilities read per agent, not one per message.
      assert.equal(s.seen.filter((r) => r.url.startsWith('/api/capabilities')).length, 1);
    } finally { await s.close(); }
  }
});

test('a failed capabilities read is kept for a minute, not asked again before every message', async () => {
  let fail = true;
  const s = await standIn((r) => {
    if (r.url.startsWith('/api/capabilities')) return fail ? [500, {error: {message: 'boom'}}] : [200, {agent: {project: true}}];
    return chatAgent({project: true})(r);
  });
  const caps = () => s.seen.filter((r) => r.url.startsWith('/api/capabilities')).length;
  try {
    await s.client.chat('t1', [{role: 'user', content: 'hi'}], 'ses-1');
    fail = false;
    await s.client.chat('t2', [{role: 'user', content: 'hi'}], 'ses-2');
    assert.equal(caps(), 1, 'the failure is remembered');
    s.client.projectFlowRetryMs = 0;   // the minute has passed
    await s.client.chat('t3', [{role: 'user', content: 'hi'}], 'ses-3');
    assert.equal(caps(), 2);
    const chats = s.seen.filter((r) => r.url === '/v1/chat/completions');
    assert.deepEqual(chats.map((c) => c.headers['x-atomic-project']), [undefined, undefined, '1']);
  } finally { await s.close(); }
});

test('a project route an agent no longer has (404 No route, 501) makes the next chat ask the capabilities again', async () => {
  let routes = true;
  const s = await standIn((r, body) => {
    if (r.url === '/api/project/decision') return routes ? [200, {view: view(), continue_message: null}] : [404, {error: {message: 'No route for POST /api/project/decision'}}];
    if (r.url.startsWith('/api/project?')) return [501, {error: {message: 'no projects here'}}];
    return chatAgent({project: true})(r);
  });
  const caps = () => s.seen.filter((r) => r.url.startsWith('/api/capabilities')).length;
  const decide = () => s.client.projectDecision({session: 'ses-1', gate: {kind: 'plan'}, version: 3, verdict: 'approve'});
  try {
    await s.client.chat('t1', [{role: 'user', content: 'hi'}], 'ses-1');
    await decide();
    await s.client.chat('t2', [{role: 'user', content: 'hi'}], 'ses-1');
    assert.equal(caps(), 1, 'a working route keeps the answer');
    routes = false;
    assert.deepEqual(await decide(), {supported: false});
    await s.client.chat('t3', [{role: 'user', content: 'hi'}], 'ses-1');
    assert.equal(caps(), 2, 'an agent that lost the route is asked again');
    assert.deepEqual(await s.client.getProject('ses-1'), {supported: false}, 'a 501 read is unsupported too');
    await s.client.chat('t4', [{role: 'user', content: 'hi'}], 'ses-1');
    assert.equal(caps(), 3);
  } finally { await s.close(); }
});

/* ---------------- (b) GET /api/project, POST /api/project/decision ---------------- */

test('getProject: the view, no project, an agent without the route', async () => {
  const v = view();
  const s = await standIn((r) => {
    if (r.url === '/api/project?session=ses%2F1') return [200, {session_id: 'ses/1', view: v}];
    if (r.url === '/api/project?session=none') return [404, {error: {message: 'no project on session none'}}];
    if (r.url === '/api/project?session=down') return [403, {error: {message: 'withheld', code: 'serve_restricted'}}];
    return [404, {error: {message: 'No route for GET /api/project'}}];
  });
  try {
    assert.deepEqual(await s.client.getProject('ses/1'), {supported: true, ok: true, view: v});
    assert.deepEqual(await s.client.getProject('none'), {supported: true, ok: true, view: null});
    assert.deepEqual(await s.client.getProject('down'), {supported: true, ok: false, status: 403, error: 'withheld'});
    assert.deepEqual(await s.client.getProject('old'), {supported: false});
  } finally { await s.close(); }
});

test('projectDecision: success with continue_message, and every refusal with its code and the current view', async () => {
  const v = view({version: 4});
  const answers = {
    ok: [200, {session_id: 'ses-1', view: v, continue_message: 'The plan is approved. Run milestone m1.'}],
    quiet: [200, {session_id: 'ses-1', view: v, continue_message: null}],
    bad: [400, {error: {message: 'verdict must be one of approve, edit'}}],
    gone: [404, {error: {message: 'no project on session gone'}}],
    stale: [409, {error: {message: 'stale', type: 'invalid_request_error', code: 'stale-version'}, view: v}],
    wrong: [409, {error: {message: 'wrong gate', code: 'wrong-gate'}, view: v}],
    running: [409, {error: {message: 'a turn is running', code: 'turn-running'}, view: v}],
    cap: [422, {error: {message: 'over the turn budget', code: 'over-cap'}, view: v}],
    old: [404, {error: {message: 'No route for POST /api/project/decision'}}],
    none: [501, {error: {message: 'this agent takes no project decisions'}}],
  };
  const s = await standIn((r, body) => answers[JSON.parse(body).session]);
  const decide = (session) => s.client.projectDecision({session, gate: {kind: 'plan'}, version: 3, verdict: 'approve'});
  try {
    assert.deepEqual(await decide('ok'), {supported: true, ok: true, view: v, continueMessage: 'The plan is approved. Run milestone m1.'});
    assert.deepEqual(await decide('quiet'), {supported: true, ok: true, view: v, continueMessage: null});
    assert.deepEqual(await decide('bad'), {supported: true, ok: false, status: 400, code: null, error: 'verdict must be one of approve, edit', view: null});
    assert.deepEqual(await decide('gone'), {supported: true, ok: false, status: 404, code: null, error: 'no project on session gone', view: null});
    assert.deepEqual(await decide('stale'), {supported: true, ok: false, status: 409, code: 'stale-version', error: 'stale', view: v});
    assert.equal((await decide('wrong')).code, 'wrong-gate');
    assert.equal((await decide('running')).code, 'turn-running');
    assert.deepEqual(await decide('cap'), {supported: true, ok: false, status: 422, code: 'over-cap', error: 'over the turn budget', view: v});
    assert.deepEqual(await decide('old'), {supported: false});
    assert.deepEqual(await decide('none'), {supported: false});
    assert.deepEqual(JSON.parse(s.seen[0].body), {session: 'ok', gate: {kind: 'plan'}, version: 3, verdict: 'approve'});
    assert.equal(s.seen[0].method, 'POST');
    assert.equal(s.seen[0].url, '/api/project/decision');
  } finally { await s.close(); }
});

/* ---------------- (b) IPC validation ---------------- */

test('the IPC takes a session id and nothing else for a read', () => {
  assert.equal(parseProjectSessionIpc('ses-1'), 'ses-1');
  for (const bad of [null, undefined, '', 7, {}, 'x'.repeat(201), 'a\nb']) assert.equal(parseProjectSessionIpc(bad), null);
});

test('the decision IPC passes a well-formed decision through, rebuilt field by field', () => {
  const ok = parseProjectDecisionIpc({session: 'ses-1', gate: {kind: 'plan', extra: 1}, version: 3, verdict: 'edit',
    edits: {rows: [{taskId: 't1', worker: 'openrouter:a', reviewer: null, x: 1}, {taskId: 't2', reviewer: 'openrouter:b'}]}, other: true});
  assert.deepEqual(ok, {ok: true, body: {session: 'ses-1', gate: {kind: 'plan'}, version: 3, verdict: 'edit',
    edits: {rows: [{taskId: 't1', worker: 'openrouter:a', reviewer: null}, {taskId: 't2', reviewer: 'openrouter:b'}]}}});
  const ms = parseProjectDecisionIpc({session: 'ses-1', gate: {kind: 'milestone', id: 'm1'}, version: 5, verdict: 'edit', edits: {note: 'Make the board bigger'}});
  assert.deepEqual(ms.body, {session: 'ses-1', gate: {kind: 'milestone', id: 'm1'}, version: 5, verdict: 'edit', edits: {note: 'Make the board bigger'}});
});

test('the decision IPC refuses what the route would refuse, before it leaves the app', () => {
  const base = {session: 'ses-1', gate: {kind: 'plan'}, version: 3, verdict: 'approve'};
  const bad = [
    null, 'x', [],
    {...base, session: ''}, {...base, session: 3},
    {...base, gate: {kind: 'nope'}}, {...base, gate: {kind: 'milestone'}}, {...base, gate: 'plan'},
    {...base, version: 0}, {...base, version: 1.5}, {...base, version: '3'},
    {...base, verdict: 'yes'},
    {...base, edits: []}, {...base, edits: {rows: 'x'}}, {...base, edits: {rows: [{worker: 'w'}]}},
    {...base, edits: {rows: [{taskId: 't', worker: 3}]}}, {...base, edits: {rows: [{taskId: 't', reviewer: 3}]}},
    {...base, edits: {rows: Array.from({length: 501}, (_, i) => ({taskId: 't' + i}))}},
    {...base, edits: {note: ''}}, {...base, edits: {note: '   '}}, {...base, edits: {note: 'x'.repeat(MAX_PROJECT_NOTE_CHARS + 1)}},
  ];
  for (const raw of bad) {
    const out = parseProjectDecisionIpc(raw);
    assert.equal(out.ok, false, JSON.stringify(raw)?.slice(0, 120));
    assert.equal(typeof out.error, 'string');
  }
  assert.equal(parseProjectDecisionIpc({...base, edits: {note: 'x'.repeat(MAX_PROJECT_NOTE_CHARS)}}).ok, true);
});

test('desktop IPC preserves approved decision status edits and validates override notes', () => {
  const base = {session: 'ses-1', gate: {kind: 'plan'}, version: 3};
  const edit = {...base, verdict: 'edit', edits: {decisionStatus: {d1: 'deferred', d2: 'informational', d3: 'active'}}};
  const override = {...base, verdict: 'approveOverReview', edits: {note: 'Reviewed by hand'}};
  for (const body of [edit, override]) assert.deepEqual(parseProjectDecisionIpc(body), {ok: true, body});
  for (const raw of [
    {...edit, edits: {decisionStatus: {d1: 'retired'}}},
    {...edit, edits: {decisionStatus: {'d 1': 'deferred'}}},
    {...edit, gate: {kind: 'brief'}},
    {...override, edits: {}},
    {...override, edits: {note: '  '}},
  ]) assert.equal(parseProjectDecisionIpc(raw).ok, false);
});
