'use strict';
// BROKEN on purpose: parseInt reads "1.5" as 1, "1e3" as 1 and "5abc" as 5, so
// fractional and malformed numbers pass. Not part of the task.
const { readFileSync } = require('node:fs');

function fail(message) {
  process.stderr.write('error: ' + message + '\n');
  process.exit(1);
}
const lines = readFileSync(process.argv[2], 'utf8').split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
if (lines[0] !== 'sku,qty,price_cents') fail('Invalid header');
const totals = new Map();
for (let i = 1; i < lines.length; i++) {
  if (lines[i].trim() === '') continue;
  const fields = lines[i].split(',');
  const [sku, qty, price] = fields;
  if (fields.length !== 3 || sku === '' || !(parseInt(qty, 10) >= 0) || !(parseInt(price, 10) >= 0)) fail('Invalid row ' + (i + 1));
  const total = (totals.get(sku) || 0) + parseInt(qty, 10) * parseInt(price, 10);
  if (!Number.isSafeInteger(total)) fail('Invalid row ' + (i + 1) + ': total too large');
  totals.set(sku, total);
}
const out = Object.create(null);
for (const [sku, total] of totals) out[sku] = total;
process.stdout.write(JSON.stringify(out) + '\n');
