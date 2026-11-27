import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
const [baseFile, candidateFile, baseRoot, candidateRoot, output] = process.argv.slice(2);
const read = p => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const a = read(baseFile); const b = read(candidateFile);
function normalize(s) {
  let value = s.replaceAll('\\', '/');
  for (const root of [baseRoot, candidateRoot]) value = value.replaceAll(resolve(root).replaceAll('\\', '/'), '<checkout>');
  return value;
}
function failed(report, root) {
  return report.testResults.flatMap(file => file.assertionResults.filter(t => t.status === 'failed').map(t => ({ file: relative(resolve(root), file.name).replaceAll('\\', '/'), name: normalize(t.fullName), messages: t.failureMessages.map(normalize) })));
}
const baseline = failed(a, baseRoot); const current = failed(b, candidateRoot);
const key = t => t.file + ' :: ' + t.name;
const baseKeys = new Set(baseline.map(key)); const candidateKeys = new Set(current.map(key));
const counts = r => Object.fromEntries(['numTotalTests','numPassedTests','numFailedTests','numPendingTests','numFailedTestSuites'].map(k => [k, r[k]]));
const result = { baseline: counts(a), candidate: counts(b), comparison: { common: current.filter(t => baseKeys.has(key(t))), additional: current.filter(t => !baseKeys.has(key(t))), baselineOnly: baseline.filter(t => !candidateKeys.has(key(t))) } };
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ baseline: result.baseline, candidate: result.candidate, common: result.comparison.common.length, additional: result.comparison.additional.length, baselineOnly: result.comparison.baselineOnly.length }));
