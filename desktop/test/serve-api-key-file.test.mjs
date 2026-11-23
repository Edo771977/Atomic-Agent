import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentClient } = require('../out/main/agent-client.js');
const inheritedKey = 'synthetic-desktop-parent-key';

function fixture(t, mode = 'ready', prepare = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'serve-key-'));
  const bin = join(dir, 'atag');
  const out = join(dir, 'observed.json');
  const keyDir = join(dir, 'serve-keys');
  const probe = fileURLToPath(new URL('./fixtures/serve-key-probe.cjs', import.meta.url));
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(bin, `#!/bin/sh\nexec ${[process.execPath, probe, out, mode].map(quote).join(' ')} "$@"\n`, { mode: 0o700 });
  if (mode === "missing") rmSync(bin);
  prepare(keyDir);
  const client = new AgentClient(dir, {
    binary: () => bin, serveRecordPath: join(dir, 'serve.json'),
    serveKeyDirectory: keyDir, healthBudgetMs: mode === "hang" ? 1000 : 3000,
  });
  process.env.ATOMIC_AGENT_API_KEY = inheritedKey;
  t.after(async () => {
    delete process.env.ATOMIC_AGENT_API_KEY;
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { client, keyDir, seen: () => JSON.parse(readFileSync(out, 'utf8')) };
}

test('serve reads its bearer from an owner-only file with no inherited key', { skip: process.platform === 'win32' }, async (t) => {
  const { client, keyDir, seen } = fixture(t);
  assert.equal((await client.start()).state, 'connected');
  const { args, path, mode, regular, envKey, token } = seen();
  assert.equal(args[0], 'serve');
  assert.equal(args[args.indexOf('--api-key-file') + 1], path);
  assert.ok(path.startsWith(keyDir + '/'));
  assert.equal(mode, 0o600);
  assert.equal(regular, true);
  assert.equal(envKey, null);
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.equal(args.includes(token), false);
  assert.deepEqual(await client.capabilities(), { authenticated: true });
});

test('removes the key before publishing a healthy agent', { skip: process.platform === 'win32' }, async (t) => {
  const { client, seen } = fixture(t);
  let presentAtConnect;
  client.on('status', (status) => {
    if (status.state === 'connected') presentAtConnect = existsSync(seen().path);
  });
  assert.equal((await client.start()).state, 'connected');
  assert.equal(presentAtConnect, false);
  assert.equal(existsSync(seen().path), false);
});

for (const mode of ['fail', 'hang', 'close', 'missing']) {
  test(`removes the key when startup ends with ${mode}`, { skip: process.platform === 'win32' }, async (t) => {
    const { client, keyDir, seen } = fixture(t, mode === 'close' ? 'hang' : mode);
    const starting = client.start();
    if (mode === 'close') {
      const deadline = Date.now() + 2000;
      while (!client.pid && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(client.pid);
      await client.close();
    } else {
      assert.equal((await starting).state, 'error');
      if (mode !== "missing") assert.equal(existsSync(seen().path), false);
    }
    await starting;
    assert.deepEqual(readdirSync(keyDir), []);
  });
}

test('removes a crashed Desktop’s leftover key without touching another live launcher', { skip: process.platform === 'win32' }, async (t) => {
  const stale = 'serve-key-2147483647-' + 'a'.repeat(32);
  const active = `serve-key-${process.pid}-` + 'b'.repeat(32);
  const { client, keyDir } = fixture(t, 'ready', (path) => {
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, stale), 'synthetic stale token', { mode: 0o600 });
    writeFileSync(join(path, active), 'synthetic active token', { mode: 0o600 });
  });
  assert.deepEqual(readdirSync(keyDir), [active]);
  assert.equal((await client.start()).state, 'connected');
  assert.deepEqual(readdirSync(keyDir), [active]);
});
