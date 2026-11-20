'use strict';
// BROKEN on purpose: it drops blank lines before numbering, so an error after a
// blank line names the wrong line (not the physical one). Not part of the task.
const { readFileSync } = require('node:fs');

function fail(message) {
  process.stderr.write('error: ' + message + '\n');
  process.exit(1);
}
const lines = readFileSync(process.argv[2], 'utf8').split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  .filter((l, i) => i === 0 || l.trim() !== '');   // blank lines dropped first, so later rows are numbered without them
if (lines[0] !== 'sku,qty,price_cents') fail('Invalid header');
const totals = new Map();
for (let i = 1; i < lines.length; i++) {
  if (lines[i].trim() === '') continue;
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
