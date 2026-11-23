// Issue #74 item 1: the approval events stream (/api/events) backs off.
// A transient refusal (404/429/5xx) or a stream that simply ends is not
// reopened at once: the reconnect waits, longer each time it fails, and a
// remote agent that refuses the token says so in the status.
// Built output. Run: npm run build && node --test test/events-stream-backoff.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentClient, eventsRetryDelay } = require('../out/main/agent-client.js');

async function stub(eventsAnswer, apiAnswer = null) {
  let events = 0;
  const server = createServer((req, res) => {
    if (req.url.startsWith('/health')) { res.setHeader('content-type', 'application/json'); return res.end('{"ok":true}'); }
    if (req.url.startsWith('/api/capabilities')) { res.setHeader('content-type', 'application/json'); return res.end('{}'); }
    if (req.url.startsWith('/api/events')) { events++; return eventsAnswer(res); }
    if (apiAnswer) return apiAnswer(req, res);
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    count: () => events,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

for (const code of [404, 429, 503]) {
  test(`an HTTP ${code} on /api/events is retried after a pause, not at once`, async () => {
    const s = await stub((res) => { res.writeHead(code, {'content-type': 'application/json'}); res.end('{"error":"no"}'); });
    const c = new AgentClient(process.cwd());
    c.setRemote({url: s.url, token: 't'});
    try {
      await c.start();
      const t0 = s.count();
      await wait(1500);
      // At most the first try plus one retry after the 1 s pause.
      assert.ok(s.count() - t0 <= 2, `requests in 1.5 s after HTTP ${code}: ${s.count() - t0}`);
    } finally {
      await c.stop?.();
      await s.close();
    }
  });
}

test('a stream that ends normally is reopened after a pause', async () => {
  const s = await stub((res) => { res.writeHead(200, {'content-type': 'text/event-stream'}); res.end(); });
  const c = new AgentClient(process.cwd());
  c.setRemote({url: s.url, token: 't'});
  try {
    await c.start();
    const t0 = s.count();
    await wait(1500);
    assert.ok(s.count() - t0 <= 2, `requests in 1.5 s after an empty stream: ${s.count() - t0}`);
  } finally {
    await c.stop?.();
    await s.close();
  }
});

test('a remote agent refusing the token on /api/events sets an error and stops reconnecting', async () => {
  const s = await stub((res) => { res.writeHead(401); res.end('{"error":"bad token"}'); });
  const c = new AgentClient(process.cwd());
  c.setRemote({url: s.url, token: 't'});
  try {
    await c.start();
    await wait(1500);
    const st = c.getStatus ? c.getStatus() : c.status;
    assert.equal(st.state, 'error');
    assert.match(st.error ?? '', /refused.*token.*401.*Settings/i);
    assert.equal(s.count(), 1);
  } finally {
    await c.stop?.();
    await s.close();
  }
});

test('the retry pause grows from 1 s and is capped at 30 s', () => {
  assert.equal(eventsRetryDelay(0), 1000);
  assert.equal(eventsRetryDelay(1), 2000);
  assert.equal(eventsRetryDelay(2), 4000);
  assert.equal(eventsRetryDelay(5), 30_000);
  assert.equal(eventsRetryDelay(50), 30_000);
});

test('a healthy stream with only keepalive comments, cut by a proxy, does not grow the pause', async () => {
  // Each connection: 200, a keepalive comment, cut after 300 ms. A stream that
  // lived past eventsHealthyMs was healthy: the next reconnect waits 1 s, not 2, 4, 8…
  const s = await stub((res) => {
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write(': keepalive\n\n');
    setTimeout(() => res.end(), 300);
  });
  const c = new AgentClient(process.cwd(), {eventsHealthyMs: 100});
  c.setRemote({url: s.url, token: 't'});
  try {
    await c.start();
    const t0 = s.count();
    await wait(5000);
    // 1 s pauses: about every 1.3 s (≥ 4 in 5 s). Growing pauses (1, 2, 4 s): 3.
    assert.ok(s.count() - t0 >= 4, `connections in 5 s: ${s.count() - t0}`);
  } finally {
    await c.stop?.();
    await s.close();
  }
});


test('an authenticated API read reports a rejected bearer', async () => {
  const s = await stub((res) => res.writeHead(200).end(), (req, res) => {
    assert.equal(req.url, '/v1/models');
    assert.equal(req.headers.authorization, 'Bearer test-token');
    res.writeHead(401).end();
  });
  const c = new AgentClient(process.cwd());
  c.setRemote({ url: s.url, token: 'test-token' });
  try {
    await c.start();
    await assert.rejects(c.models(), /refused.*token.*401.*Settings/i);
  } finally {
    await c.stop();
    await s.close();
  }
});
