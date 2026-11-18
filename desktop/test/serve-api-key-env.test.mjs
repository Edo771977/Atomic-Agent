// Issue #74 item 3: the per-launch API key reaches `atag serve` in its
// environment (ATOMIC_AGENT_API_KEY), not as `--api-key <token>` on the
// command line every user's `ps` shows.
// Built output. Run: npm run build && node --test test/serve-api-key-env.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'serve-key-'));
process.env.ATOMIC_AGENT_STATE_DIR = join(dir, 'state');
const out = join(dir, 'seen.txt');
process.env.SERVE_KEY_PROBE_OUT = out;
const require = createRequire(import.meta.url);
const { AgentClient } = require('../out/main/agent-client.js');

test('serve is started with the key in ATOMIC_AGENT_API_KEY and without --api-key', { skip: process.platform === 'win32' }, async () => {
  const bin = join(dir, 'fake-atag');
  writeFileSync(bin, '#!/bin/sh\nfor a in "$@"; do echo "ARG $a"; done > "$SERVE_KEY_PROBE_OUT"\necho "KEY $ATOMIC_AGENT_API_KEY" >> "$SERVE_KEY_PROBE_OUT"\nexit 3\n');
  chmodSync(bin, 0o755);
  const c = new AgentClient(dir, {binary: () => bin, serveRecordPath: join(dir, 'serve.json'), healthBudgetMs: 3000});
  try {
    await c.start();
    for (let i = 0; i < 50 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
    const seen = readFileSync(out, 'utf8');
    assert.match(seen, /^ARG serve$/m);
    assert.doesNotMatch(seen, /--api-key/, 'the key is not on the command line');
    assert.ok(c.token && c.token.length >= 32, 'a key was made');
    assert.doesNotMatch(seen, new RegExp('^ARG ' + c.token + '$', 'm'), 'the key is not an argument either');
    assert.match(seen, new RegExp('^KEY ' + c.token + '$', 'm'), 'the key is in the environment');
  } finally {
    await c.stop();
  }
});

test('the desktop app\'s own environment does not keep the key', () => {
  assert.equal(process.env.ATOMIC_AGENT_API_KEY, undefined);
});
