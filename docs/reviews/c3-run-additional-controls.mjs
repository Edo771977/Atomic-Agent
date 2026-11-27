// node c3-run-additional-controls.mjs <comparison.json> <checkout> <output.json> [workers=2]
// Runs only the initially additional failed names. No timeout or exclusion changes.
import { readFileSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
const [comparison, checkout, output, workerArg = '2'] = process.argv.slice(2);
const root = resolve(checkout); const destination = resolve(output);
const extra = JSON.parse(readFileSync(comparison, 'utf8')).comparison.additional;
const files = [...new Set(extra.map(t => t.file))];
if (!extra.length) throw new Error('No additional names to control');
if (files.some(p => !(p.startsWith('src/') || p.startsWith('scripts/')) || p.includes('..'))) throw new Error('Unexpected test path');
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = `^(?:${extra.map(t => escape(t.name.replaceAll('<checkout>', root))).join('|')})$`;
const log = openSync(`${destination}.log`, 'w');
const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...files, `--maxWorkers=${Number(workerArg)}`, '--testNamePattern', pattern, '--reporter=json', `--outputFile=${destination}`];
const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', log, log] });
const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
closeSync(log);
const result = JSON.parse(readFileSync(destination, 'utf8'));
if (result.numPassedTests + result.numFailedTests !== extra.length) throw new Error('Not all requested names ran');
console.log(JSON.stringify({ requested: extra.length, files: files.length, passed: result.numPassedTests, failed: result.numFailedTests, pendingOtherCases: result.numPendingTests, exit: code }));
process.exitCode = code ?? 1;
