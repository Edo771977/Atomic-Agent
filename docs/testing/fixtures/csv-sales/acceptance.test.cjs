'use strict';
// Independent acceptance test for the CSV sales summarizer the agent builds
// from prompt.txt (issue #95). Written by us, never by the agent: it drives
// any program that follows the prompt's interface.
//
//   node sales.cjs <input.csv>
//   - first line exactly `sku,qty,price_cents` (a trailing \r allowed), else
//     stderr contains "Invalid header", stdout is empty, exit 1;
//   - later non-blank lines: sku, qty, price_cents; qty and price_cents are
//     non-negative decimal digit strings; any other row: stderr contains
//     "Invalid row", stdout is empty, exit 1;
//   - success: one JSON object on stdout, sku -> integer revenue in cents
//     (sum of qty * price_cents), exit 0.
//
// Run: CSV_SALES_PROGRAM=<path to sales.cjs> node --test acceptance.test.cjs
// (without the variable, sales.cjs in the current folder). Inputs are written
// to a temporary folder, never next to the program. Node built-ins only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const PROGRAM = resolve(process.env.CSV_SALES_PROGRAM || 'sales.cjs');
const HEADER = 'sku,qty,price_cents';
const dir = mkdtempSync(join(tmpdir(), 'csv-sales-acceptance-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
/** Runs the program on `text` written to a fresh file. */
function run(text) {
  const file = join(dir, `input-${++n}.csv`);
  writeFileSync(file, text);
  const r = spawnSync(process.execPath, [PROGRAM, file], { encoding: 'utf8', timeout: 20_000, cwd: dir });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

/** The summary as [sku, cents] pairs in sku order, own keys only (JSON.parse keeps `__proto__` as a key). */
function summary(r) {
  assert.equal(r.error, undefined, `the program could not be run: ${r.error}`);
  assert.equal(r.code, 0, `exit ${r.code}; stderr: ${r.stderr.trim()}`);
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); }, `stdout is not one JSON object: ${JSON.stringify(r.stdout)}`);
  assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'stdout is a JSON object');
  const pairs = Object.keys(parsed).map((k) => [k, parsed[k]]);
  for (const [k, v] of pairs) assert.ok(Number.isSafeInteger(v), `revenue of ${k} is an integer: ${JSON.stringify(v)}`);
  return pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
const pairsOf = (json) => { const o = JSON.parse(json); return Object.keys(o).map((k) => [k, o[k]]).sort((a, b) => (a[0] < b[0] ? -1 : 1)); };

/** A refusal: exit 1, nothing on stdout, `words` on stderr. */
function refused(r, words, input) {
  assert.equal(r.error, undefined, `the program could not be run: ${r.error}`);
  assert.equal(r.code, 1, `exit ${r.code} for ${JSON.stringify(input)}; stdout: ${r.stdout.trim()}`);
  assert.equal(r.stdout.trim(), '', `nothing on stdout for ${JSON.stringify(input)}`);
  assert.match(r.stderr, words, `stderr for ${JSON.stringify(input)}`);
}

test('repeated skus are summed per sku', () => {
  const input = [HEADER, 'A,2,500', 'B,1,250', 'A,3,500', 'C,10,1', 'B,4,250', ''].join('\n');
  assert.deepEqual(summary(run(input)), [['A', 2500], ['B', 1250], ['C', 10]]);
});

test('Windows line endings and a missing final newline are accepted', () => {
  assert.deepEqual(summary(run([HEADER, 'A,2,500', 'A,1,1'].join('\r\n'))), [['A', 1001]]);
});

test('zero quantities and zero prices give zero revenue and keep the sku', () => {
  const input = [HEADER, 'Z,0,999', 'Y,5,0', 'X,0,0', 'Y,0,7', ''].join('\n');
  assert.deepEqual(summary(run(input)), [['X', 0], ['Y', 0], ['Z', 0]]);
});

test('a header-only file is an empty summary', () => {
  assert.deepEqual(summary(run(HEADER + '\n')), []);
});

test('prototype-key skus are ordinary skus', () => {
  const input = [HEADER, 'toString,2,100', '__proto__,1,7', 'constructor,3,1', 'hasOwnProperty,1,1', 'toString,1,5', 'valueOf,0,3', ''].join('\n');
  assert.deepEqual(
    summary(run(input)),
    pairsOf('{"__proto__":7,"constructor":3,"hasOwnProperty":1,"toString":205,"valueOf":0}'),
  );
});

test('a wrong first line is refused with "Invalid header"', () => {
  for (const first of ['sku,quantity,price_cents', 'qty,sku,price_cents', 'sku,qty', 'sku,qty,price_cents,extra', 'A,1,100', '', ' sku,qty,price_cents']) {
    // No valid header anywhere before the data: the first line itself is wrong.
    const input = [first, 'A,1,100', ''].join('\n');
    refused(run(input), /Invalid header/, input);
  }
  refused(run(''), /Invalid header/, '');
});

test('a valid header further down does not rescue a wrong first line', () => {
  const input = ['sku,amount,price_cents', HEADER, 'A,1,100', ''].join('\n');
  refused(run(input), /Invalid header/, input);
});

test('negative numbers are refused', () => {
  for (const row of ['A,-1,100', 'A,1,-100', 'A,-0,5']) {
    const input = [HEADER, 'B,1,1', row, ''].join('\n');
    refused(run(input), /Invalid row/, input);
  }
});

test('non-integer numbers are refused', () => {
  for (const row of ['A,1.5,100', 'A,1,99.9', 'A,1e3,1', 'A,0x10,1', 'A,1,+5', 'A, 1,5']) {
    const input = [HEADER, row, ''].join('\n');
    refused(run(input), /Invalid row/, input);
  }
});

test('non-numeric and missing values are refused', () => {
  for (const row of ['A,abc,100', 'A,1,ten', 'A,,100', 'A,1,', ',1,100', 'A,1', 'A,1,100,9']) {
    const input = [HEADER, row, ''].join('\n');
    refused(run(input), /Invalid row/, input);
  }
});
