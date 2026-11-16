// Issue #39, desktop half: project_gate frames on /api/events and in a
// chat stream reach the app as their own `project` event (AgentClient).
// Built output.
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentClient, routeEventsFrame, readProjectGateFrame } = require('../out/main/agent-client.js');

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
        // An events stream stays open, as the agent's does: an ended one is reconnected.
        res.writeHead(code, headers);
        if (req.url === '/api/events') res.write(out); else res.end(out);
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

/* ---------------- (a) routing ---------------- */

test('an events frame goes by its name: project_gate is its own event, everything else stays an approval', () => {
  const v = view();
  assert.deepEqual(routeEventsFrame({event: 'project_gate', data: JSON.stringify({session_id: 'ses-1', view: v})}),
    {channel: 'project', payload: {sessionId: 'ses-1', view: v}});
  const req = {approvalId: 'a1', sessionId: 'ses-1', tool: 'os.fs.write'};
  assert.deepEqual(routeEventsFrame({event: 'approval_request', data: JSON.stringify(req)}), {channel: 'approval', payload: req});
  // An unnamed frame (older agents) keeps the old way.
  assert.deepEqual(routeEventsFrame({event: 'message', data: JSON.stringify(req)}), {channel: 'approval', payload: req});
  assert.equal(routeEventsFrame({event: 'approval_request', data: '{oops'}), null);
  assert.equal(routeEventsFrame({event: 'message', data: '[DONE]'}), null);
});

test('a project_gate frame without a session or a view of schema 1 is dropped', () => {
  assert.equal(readProjectGateFrame({view: view()}), null);
  assert.equal(readProjectGateFrame({session_id: 'ses-1'}), null);
  assert.equal(readProjectGateFrame({session_id: 'ses-1', view: view({schema: 2})}), null);
  assert.equal(readProjectGateFrame({session_id: 'ses-1', view: view({gate: null})}), null);
  assert.equal(readProjectGateFrame({session_id: 'ses-1', view: view({allowedVerdicts: 'approve'})}), null);
  // The chat stream's copy carries `object`; it is the same view.
  const v = view();
  assert.deepEqual(readProjectGateFrame({object: 'atomic.project_gate', session_id: 'ses-1', view: v}), {sessionId: 'ses-1', view: v});
});

test('the events stream emits project for project_gate and approval only for approval requests', async () => {
  const v = view();
  const req = {approvalId: 'a1', sessionId: 'ses-1', tool: 'os.fs.write'};
  const s = await standIn((r) => r.url === '/api/events'
    ? [200, sse([['approval_request', req], ['project_gate', {session_id: 'ses-1', view: v}]]), SSE]
    : [404, {error: {message: 'No route'}}]);
  const approvals = [], projects = [];
  s.client.on('approval', (e) => approvals.push(e));
  s.client.on('project', (e) => projects.push(e));
  try {
    s.client.openApprovalStream(() => true);
    for (let i = 0; i < 100 && projects.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(approvals, [req]);
    assert.deepEqual(projects, [{sessionId: 'ses-1', view: v}]);
  } finally { s.client.events?.abort(); await s.close(); }
});

/* ---------------- chat stream ---------------- */

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

test('a project_gate frame in a chat stream becomes a project event, not a chat frame', async () => {
  const s = await standIn(chatAgent({project: true}));
  const chats = [], projects = [];
  s.client.on('chat', (e) => chats.push(e));
  s.client.on('project', (e) => projects.push(e));
  try {
    await s.client.chat('t1', [{role: 'user', content: 'build it'}], 'ses-1');
    assert.equal(projects.length, 1);
    assert.equal(projects[0].sessionId, 'ses-1');
    assert.equal(projects[0].view.version, 3);
    assert.ok(!chats.some((e) => e.kind === 'project_gate'));
    assert.ok(chats.some((e) => e.kind === 'delta' && e.text === 'ok'));
  } finally { await s.close(); }
});

