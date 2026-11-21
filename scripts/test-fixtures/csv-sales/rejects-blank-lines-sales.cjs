'use strict';
// BROKEN on purpose: blank lines are refused as invalid rows instead of skipped
// (the issue #100 run lost its blank-line handling). Not part of the task.
const { readFileSync } = require('node:fs');

function fail(message) {
  process.stderr.write('error: ' + message + '\n');
  process.exit(1);
}
const lines = readFileSync(process.argv[2], 'utf8').split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
if (lines[0] !== 'sku,qty,price_cents') fail('Invalid header');
const totals = new Map();
for (let i = 1; i < lines.length; i++) {
  // Only the empty string after the final newline is skipped; any other blank line is an invalid row.
  if (lines[i] === '' && i === lines.length - 1) continue;
  const fields = lines[i].split(',');
  const [sku, qty, price] = fields;
  if (fields.length !== 3 || sku === '' || !/^[0-9]+$/.test(qty) || !/^[0-9]+$/.test(price)) fail('Invalid row ' + (i + 1));
  const total = (totals.get(sku) || 0) + Number(qty) * Number(price);
  if (!Number.isSafeInteger(total)) fail('Invalid row ' + (i + 1) + ': total too large');
  totals.set(sku, total);
}
const out = Object.create(null);
for (const [sku, total] of totals) out[sku] = total;
process.stdout.write(JSON.stringify(out) + '\n');
