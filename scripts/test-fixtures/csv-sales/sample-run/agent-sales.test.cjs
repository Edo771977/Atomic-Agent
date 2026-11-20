'use strict';
// A stand-in for the agent's own sales.test.cjs in the runner's unit test.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { writeFileSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
test('sums one sku', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agent-test-')), 'in.csv');
  writeFileSync(file, 'sku,qty,price_cents\nA,2,3\n');
  const r = spawnSync(process.execPath, [join(__dirname, 'sales.cjs'), file], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { A: 6 });
});
