// Issue #109, part 2: the Fusion projects list through AgentClient
// (GET /api/projects, POST /api/projects/forget|resume), the problem on
// GET /api/project's 404, and the folder check of the IPC
// (main/project-ipc.ts). Built output.
// Run: npm run build && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentClient } = require('../out/main/agent-client.js');
const { parseProjectFolderIpc } = require('../out/main/project-ipc.js');

async function standIn(answer) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({method: req.method, url: req.url, body});
      const [code, out] = answer(req, body);
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

const ROWS = [
  {folder: '/w/game', status: 'ok', zone: 'needs-you', name: 'game', gate: 'plan', next: 'you approve the plan', updatedAt: 5, spentUsd: 0.4},
  {folder: '/w/gone', status: 'missing', zone: 'problem', problem: 'The folder is gone.'},
];

test('the list, forget and resume go to the agent and come back as the window reads them', async () => {
  const s = await standIn((r, body) => {
    if (r.url === '/api/projects') return [200, {schema: 1, projects: ROWS, registry_problem: null}];
    if (r.url === '/api/projects/forget') return [200, {schema: 1, folder: JSON.parse(body).folder, forgotten: true}];
    if (r.url === '/api/projects/resume') {
      const {folder} = JSON.parse(body);
      if (folder === '/w/game') return [200, {schema: 1, folder, name: 'game', session_id: 's-9', created: true, view: {schema: 1, gate: {kind: 'plan'}}}];
      return [422, {schema: 1, folder, error: {message: 'The project file is damaged.', type: 'invalid_request_error', code: 'project-unavailable'}}];
    }
    return [404, {error: {message: 'No route for ' + r.url}}];
  });
  try {
    assert.deepEqual(await s.client.listFusionProjects(), {supported: true, ok: true, projects: ROWS, registryProblem: null});
    assert.deepEqual(await s.client.forgetFusionProject('/w/gone'), {supported: true, ok: true, forgotten: true});
    assert.deepEqual(JSON.parse(s.seen.at(-1).body), {folder: '/w/gone'});
    assert.deepEqual(await s.client.resumeFusionProject('/w/game'),
      {supported: true, ok: true, sessionId: 's-9', created: true, name: 'game', view: {schema: 1, gate: {kind: 'plan'}}});
    assert.deepEqual(await s.client.resumeFusionProject('/w/broken'),
      {supported: true, ok: false, status: 422, code: 'project-unavailable', error: 'The project file is damaged.'});
  } finally { await s.close(); }
});

test('an agent without the routes is not supported; a damaged list says so', async () => {
  const old = await standIn((r) => [404, {error: {message: 'No route for ' + r.method + ' ' + r.url}}]);
  try {
    assert.deepEqual(await old.client.listFusionProjects(), {supported: false});
    assert.deepEqual(await old.client.resumeFusionProject('/w/game'), {supported: false});
    assert.deepEqual(await old.client.forgetFusionProject('/w/game'), {supported: false});
  } finally { await old.close(); }
  const damaged = await standIn(() => [200, {schema: 1, projects: [], registry_problem: 'registry.json is not valid JSON'}]);
  try {
    assert.deepEqual(await damaged.client.listFusionProjects(), {supported: true, ok: true, projects: [], registryProblem: 'registry.json is not valid JSON'});
  } finally { await damaged.close(); }
});

test('GET /api/project: a chat whose project did not open brings its problem', async () => {
  const s = await standIn((r) => r.url.includes('broken')
    ? [404, {error: {message: 'no project on session broken'}, project_problem: 'The project file is damaged.'}]
    : [404, {error: {message: 'no project on session plain'}}]);
  try {
    assert.deepEqual(await s.client.getProject('broken'), {supported: true, ok: true, view: null, problem: 'The project file is damaged.'});
    assert.deepEqual(await s.client.getProject('plain'), {supported: true, ok: true, view: null});
  } finally { await s.close(); }
});

test('the IPC takes one absolute folder, nothing else', () => {
  assert.equal(parseProjectFolderIpc('/w/game'), '/w/game');
  assert.equal(parseProjectFolderIpc('C:\\work\\game'), 'C:\\work\\game');
  for (const bad of ['game', '', '/w/a\nb', 7, null, {folder: '/w'}, '/' + 'x'.repeat(5000)]) assert.equal(parseProjectFolderIpc(bad), null, String(bad));
});
