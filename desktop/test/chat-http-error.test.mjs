// A turn the agent refuses before it streams (a 4xx with an OpenAI-style
// JSON error, e.g. a project's cloud model not allowed in a constrained
// folder, or folder_restricted 403): the window shows the agent's words,
// not a bare "HTTP 400". The body is read bounded and only as JSON.
// Run: npm run build && node --test test/chat-http-error.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentClient } = require('../out/main/agent-client.js');

async function turnError(status, headers, body) {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(status, headers); res.end(body); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new AgentClient(process.cwd());
  client.port = server.address().port;
  client.token = 't0ken';
  client.projectFlowSupported = async () => false;
  const events = [];
  client.on('chat', (ev) => events.push(ev));
  try {
    await client.chat('turn-1', [{ role: 'user', content: 'hi' }], 'chat-1', '/work/site');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const errs = events.filter((e) => e.kind === 'error');
  assert.equal(errs.length, 1);
  return errs[0];
}

const JSON_TYPE = { 'content-type': 'application/json' };
const REFUSAL = 'llm provider "openrouter" may not receive this chat\'s content: folder /work/site is restricted to: local-llama';

test('a 400 with a JSON error shows the agent\'s message', async () => {
  const ev = await turnError(400, JSON_TYPE, JSON.stringify({ error: { message: REFUSAL, type: 'invalid_request_error', param: 'provider_id', code: null } }));
  assert.equal(ev.error, REFUSAL);
  assert.equal(ev.httpStatus, 400);
  assert.equal(ev.transport, true);
});

test('a 403 with a code shows the message and the code', async () => {
  const ev = await turnError(403, JSON_TYPE, JSON.stringify({ error: { message: 'folder /x is restricted', code: 'folder_restricted' } }));
  assert.equal(ev.error, 'folder /x is restricted (folder_restricted)');
  assert.equal(ev.httpStatus, 403);
});

test('not JSON, no message, or an oversized body: the plain status', async () => {
  assert.equal((await turnError(400, { 'content-type': 'text/html' }, '<h1>Bad</h1>')).error, 'HTTP 400');
  assert.equal((await turnError(400, JSON_TYPE, 'not json')).error, 'HTTP 400');
  assert.equal((await turnError(400, JSON_TYPE, JSON.stringify({ error: {} }))).error, 'HTTP 400');
  const big = JSON.stringify({ error: { message: 'x'.repeat(100_000) } });
  assert.equal((await turnError(400, JSON_TYPE, big)).error, 'HTTP 400');
});

test('a long or multi-line message is cleaned and clipped', async () => {
  const ev = await turnError(400, JSON_TYPE, JSON.stringify({ error: { message: 'line one\n\u0007line two ' + 'y'.repeat(2000) } }));
  assert.ok(ev.error.startsWith('line one line two y'), ev.error);
  assert.ok(Array.from(ev.error).length <= 500, String(ev.error.length));
});

test('only a 4xx is read: a 5xx keeps the plain status', async () => {
  const ev = await turnError(500, JSON_TYPE, JSON.stringify({ error: { message: 'internal: /home/me/secret stack' } }));
  assert.equal(ev.error, 'HTTP 500');
  assert.equal(ev.httpStatus, 500);
});
