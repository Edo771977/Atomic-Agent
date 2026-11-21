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
//     "Invalid row N" (N its physical line number, the header line 1),
//     stdout is empty, exit 1; blank lines are skipped but counted; a total
//     above Number.MAX_SAFE_INTEGER makes the row that takes it there invalid,
//     while each qty and price may have any number of digits;
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
  const r = run(input);
  assert.deepEqual(
    summary(r),
    pairsOf('{"__proto__":7,"constructor":3,"hasOwnProperty":1,"toString":205,"valueOf":0}'),
  );
  // Read as data (JSON.parse), never as code: `__proto__` is an own property of the result with its value.
  const parsed = JSON.parse(r.stdout);
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, '__proto__'), '__proto__ is an own property of the summary');
  assert.equal(Object.getOwnPropertyDescriptor(parsed, '__proto__').value, 7);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype, 'the summary keeps the ordinary prototype');
});

// Issue #100: blank lines after the header are skipped, but still counted in an error's line number.
test('a blank line between two sales is skipped', () => {
  const input = [HEADER, 'A,1,100', '', 'B,2,50', '   ', 'A,1,1', ''].join('\n');
  assert.deepEqual(summary(run(input)), [['A', 101], ['B', 100]]);
});

test('several trailing blank lines are skipped', () => {
  assert.deepEqual(summary(run([HEADER, 'A,1,1', 'B,0,9', '', '', '', ''].join('\n'))), [['A', 1], ['B', 0]]);
  assert.deepEqual(summary(run([HEADER, 'A,2,1', '', '', ''].join('\r\n'))), [['A', 2]]);
});

test('an invalid row after a blank line names its physical line number', () => {
  // Line 1 the header, 2 a sale, 3 blank, 4 blank, 5 the invalid row.
  const input = [HEADER, 'A,1,1', '', '', 'B,x,1', 'C,1,1', ''].join('\n');
  const r = run(input);
  refused(r, /Invalid row 5(?!\d)/, input);
  assert.doesNotMatch(r.stderr, /Invalid row 3(?!\d)/, 'the line number counts the blank lines');
});

// Issue #106: the limit is on the accumulated total, not on each number; a qty or a price may itself be
// larger than Number.MAX_SAFE_INTEGER (9007199254740991) when the total stays within it.
test('a zero price makes a huge quantity a zero total', () => {
  assert.deepEqual(summary(run([HEADER, 'X,9007199254740993,0', ''].join('\n'))), [['X', 0]]);
  assert.deepEqual(summary(run([HEADER, 'X,123456789012345678901234567890,0', 'X,2,3', ''].join('\n'))), [['X', 6]]);
});

test('a zero quantity makes a huge price a zero total', () => {
  assert.deepEqual(summary(run([HEADER, 'Y,0,9007199254740993', ''].join('\n'))), [['Y', 0]]);
  assert.deepEqual(summary(run([HEADER, 'Y,0,999999999999999999999999', ''].join('\n'))), [['Y', 0]]);
});

test('a total exactly at Number.MAX_SAFE_INTEGER is accepted', () => {
  assert.deepEqual(summary(run([HEADER, 'M,1,9007199254740991', ''].join('\n'))), [['M', 9007199254740991]]);
  // Reached by accumulation over two rows.
  assert.deepEqual(summary(run([HEADER, 'M,1,9007199254740990', 'M,1,1', ''].join('\n'))), [['M', 9007199254740991]]);
});

test('a total one past Number.MAX_SAFE_INTEGER is refused', () => {
  const single = [HEADER, 'A,1,1', 'M,1,9007199254740992', ''].join('\n');
  refused(run(single), /Invalid row 3(?!\d)/, single);
  // The row that takes the accumulated total over the limit is the invalid one.
  const accumulated = [HEADER, 'M,1,9007199254740990', 'M,2,1', ''].join('\n');
  refused(run(accumulated), /Invalid row 3(?!\d)/, accumulated);
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
