import { readFileSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";

const [baselinePath, candidatePath, baselineRoot, candidateRoot, outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error("Usage: node c1-compare-tests.mjs baseline.json candidate.json baseline-root candidate-root output.json");
const slash = value => value.replaceAll("\\", "/");
function load(path, root) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  const absoluteRoot = slash(resolve(root));
  const scrub = value => slash(value).replaceAll(absoluteRoot, "<checkout>")
    .replace(/C:\/Users\/[^/\s]+\/AppData\/Local\/Temp\/[^/\s'"\n]+/g, "<temporary-fixture>");
  const tests = report.testResults.flatMap(suite => {
    const file = slash(relative(root, suite.name));
    if (suite.status === "failed" && suite.assertionResults.length === 0) {
      return [{ file, name: "<module collection>", status: "failed", failures: [scrub(suite.message ?? "").slice(0, 1600)] }];
    }
    return suite.assertionResults.map(test => ({
      file, name: scrub(test.fullName), status: test.status,
      failures: test.failureMessages.map(message => scrub(message).slice(0, 1600)),
    }));
  });
  return {
    counts: { total: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests, skipped: report.numPendingTests },
    tests, failures: tests.filter(test => test.status === "failed"),
  };
}
const baseline = load(baselinePath, baselineRoot), candidate = load(candidatePath, candidateRoot);
const key = test => `${test.file} :: ${test.name}`;
const selectedFiles = new Set(candidate.tests.map(test => test.file));
const comparedBaselineFailures = baseline.failures.filter(test => selectedFiles.has(test.file));
const baselineFailures = new Map(comparedBaselineFailures.map(test => [key(test), test]));
const candidateFailures = new Map(candidate.failures.map(test => [key(test), test]));
writeFileSync(outputPath, JSON.stringify({
  baseline: baseline.counts, candidate: candidate.counts,
  common: candidate.failures.filter(test => baselineFailures.has(key(test))),
  additional: candidate.failures.filter(test => !baselineFailures.has(key(test))),
  baselineOnly: comparedBaselineFailures.filter(test => !candidateFailures.has(key(test))),
  baselineFailuresOutsideCandidateSelection: baseline.failures.filter(test => !selectedFiles.has(test.file)),
  newC1Tests: candidate.tests.filter(test => /C1[a-e]:?|C1a worker depth|runWorkerTasksCore|worker turn origin/.test(test.name)),
}, null, 2) + "\n");
