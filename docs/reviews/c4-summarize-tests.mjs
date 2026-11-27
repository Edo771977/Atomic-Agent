import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const [input, output, baseline] = process.argv.slice(2);
if (!input || !output) throw Error('Usage: node c4-summarize-tests.mjs report.json summary.json [main-report.json]');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const fileOf = name => name.replaceAll('\\', '/').match(/(?:^|\/)((?:src|scripts|eval|eval-memory)\/.*)$/)?.[1] ?? basename(name);
const failures = report => report.testResults.flatMap(suite => suite.assertionResults.filter(t => t.status === 'failed').map(t => ({ file: fileOf(suite.name), name: t.fullName })));
const suiteErrors = report => report.testResults.filter(s => s.status === 'failed' && !s.assertionResults.some(t => t.status === 'failed')).map(s => ({ file: fileOf(s.name), message: s.message }));
const report = read(input);
const summary = {
  report: basename(input), success: report.success,
  tests: { passed: report.numPassedTests, failed: report.numFailedTests, pending: report.numPendingTests, total: report.numTotalTests },
  suites: { passed: report.numPassedTestSuites, failed: report.numFailedTestSuites, pending: report.numPendingTestSuites },
  runtimeErrorSuites: report.numRuntimeErrorTestSuites,
  wasInterrupted: report.wasInterrupted,
  failures: failures(report),
  suiteErrors: suiteErrors(report),
};
if (baseline) {
  const base = read(baseline); const baseFailures = failures(base);
  const keys = new Set(baseFailures.map(f => `${f.file}\n${f.name}`));
  const current = new Set(summary.failures.map(f => `${f.file}\n${f.name}`));
  summary.main = { report: basename(baseline), tests: { passed: base.numPassedTests, failed: base.numFailedTests, pending: base.numPendingTests } };
  summary.newFailureNames = summary.failures.filter(f => !keys.has(`${f.file}\n${f.name}`));
  summary.mainOnlyFailureNames = baseFailures.filter(f => !current.has(`${f.file}\n${f.name}`));
  const baseErrorFiles = new Set(suiteErrors(base).map(s => s.file));
  summary.newSuiteErrorFiles = summary.suiteErrors.filter(s => !baseErrorFiles.has(s.file));
}
writeFileSync(output, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
