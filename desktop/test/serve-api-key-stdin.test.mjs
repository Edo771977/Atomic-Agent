import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
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
    serveKeyDirectory: keyDir, healthBudgetMs: 3000,
  });
  process.env.ATOMIC_AGENT_API_KEY = inheritedKey;
  t.after(async () => {
    delete process.env.ATOMIC_AGENT_API_KEY;
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { client, keyDir, seen: () => JSON.parse(readFileSync(out, 'utf8')) };
}

test('serve authenticates with one newline-terminated stdin bearer and no key file', { skip: process.platform === 'win32' }, async (t) => {
  const { client, keyDir, seen } = fixture(t);
  assert.equal((await client.start()).state, 'connected');
  const { args, input, envKey, token } = seen();
  assert.equal(args[0], 'serve');
  assert.ok(args.includes('--api-key-stdin'));
  assert.equal(args.includes('--api-key-file'), false);
  assert.equal(args.join(' ').includes(token), false);
  assert.equal(args.join(' ').includes(inheritedKey), false);
  assert.equal(envKey, null);
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.equal(input, token + '\n');
  assert.equal(existsSync(keyDir), false);
  assert.deepEqual(await client.capabilities(), { authenticated: true });
  await client.stop();
  assert.equal((await client.start()).state, 'connected');
  assert.notEqual(seen().token, token);
  assert.deepEqual(await client.capabilities(), { authenticated: true });
});

test('a stdin write error stops startup and permits a restart', { skip: process.platform === 'win32' }, async (t) => {
  const { client, keyDir } = fixture(t);
  const spawn = childProcess.spawn;
  let failWrite = true;
  const mock = t.mock.method(childProcess, 'spawn', (...args) => {
    const child = spawn(...args);
    if (failWrite && args[1][0] === 'serve' && child.stdin) {
      t.mock.method(child.stdin, 'end', () => {
        child.stdin.destroy(Object.assign(new Error('test broken pipe'), { code: 'EPIPE' }));
        return child.stdin;
      });
    }
    return child;
  });
  try {
    const status = await client.start();
    assert.equal(status.state, 'error');
    assert.match(status.error, /could not send.*API key.*stdin/i);
    assert.equal(client.pid, null);
    assert.equal(existsSync(keyDir), false);
    failWrite = false;
    assert.equal((await client.start()).state, 'connected');
  } finally {
    mock.mock.restore();
  }
});

test('an older core prints an upgrade message even if its diagnostic has no trailing newline', { skip: process.platform === 'win32' }, async (t) => {
  const { client } = fixture(t, 'old');
  const status = await client.start();
  assert.equal(status.state, 'error');
  assert.match(status.error, /core.*too old.*--api-key-stdin.*update/i);
});

for (const kind of ['symlink', 'file', 'open directory']) {
  test(`starts without using the legacy key path when it is a symlink, file or non-private directory (${kind})`, { skip: process.platform === 'win32' }, async (t) => {
    const { client, keyDir } = fixture(t, 'ready', (path) => {
      if (kind === 'symlink') symlinkSync(tmpdir(), path);
      else if (kind === 'file') writeFileSync(path, 'leave this alone');
      else { mkdirSync(path); chmodSync(path, 0o755); }
    });
    assert.equal((await client.start()).state, 'connected');
    assert.equal(existsSync(keyDir), true);
  });
}

test('a missing binary reports its launch error without creating a key directory', { skip: process.platform === 'win32' }, async (t) => {
  const { client, keyDir } = fixture(t, 'missing');
  const status = await client.start();
  assert.equal(status.state, 'error');
  assert.match(status.error, /could not be started/i);
  assert.equal(existsSync(keyDir), false);
});

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

test('Linux procfs contains neither the inherited key nor the stdin bearer in environ or cmdline', { skip: process.platform !== 'linux' }, async (t) => {
  const { client, seen } = fixture(t);
  assert.equal((await client.start()).state, 'connected');
  assert.ok(client.pid);
  const environ = readFileSync(`/proc/${client.pid}/environ`, 'utf8');
  assert.ok(environ.includes('PATH='), 'read the live process environment');
  assert.equal(environ.includes('ATOMIC_AGENT_API_KEY='), false);
  assert.equal(environ.includes(inheritedKey), false);
  assert.equal(environ.includes(seen().token), false);
  const cmdline = readFileSync(`/proc/${client.pid}/cmdline`, 'utf8').split('\0');
  assert.ok(cmdline.includes('--api-key-stdin'));
  assert.equal(cmdline.some((arg) => arg.includes(seen().token) || arg.includes(inheritedKey)), false);
});
