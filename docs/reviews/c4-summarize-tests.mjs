import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const [input, output, baseline] = process.argv.slice(2);
if (!input || !output) throw Error('Usage: node c4-summarize-tests.mjs report.json summary.json [main-report.json]');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const failures = report => report.testResults.flatMap(suite => suite.assertionResults.filter(t => t.status === 'failed').map(t => ({ file: suite.name.replaceAll('\\', '/').split('/src/').pop(), name: t.fullName })));
const report = read(input);
const summary = {
  report: basename(input), success: report.success,
  tests: { passed: report.numPassedTests, failed: report.numFailedTests, pending: report.numPendingTests, total: report.numTotalTests },
  suites: { passed: report.numPassedTestSuites, failed: report.numFailedTestSuites, pending: report.numPendingTestSuites },
  failures: failures(report),
  suiteErrors: report.testResults.filter(s => s.status === 'failed' && !s.assertionResults.some(t => t.status === 'failed')).map(s => ({ file: s.name.replaceAll('\\', '/').split('/src/').pop(), message: s.message })),
};
if (baseline) {
  const base = read(baseline); const baseFailures = failures(base);
  const keys = new Set(baseFailures.map(f => `${f.file}\n${f.name}`));
  const current = new Set(summary.failures.map(f => `${f.file}\n${f.name}`));
  summary.main = { report: basename(baseline), tests: { passed: base.numPassedTests, failed: base.numFailedTests, pending: base.numPendingTests } };
  summary.newFailureNames = summary.failures.filter(f => !keys.has(`${f.file}\n${f.name}`));
  summary.mainOnlyFailureNames = baseFailures.filter(f => !current.has(`${f.file}\n${f.name}`));
}
writeFileSync(output, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
