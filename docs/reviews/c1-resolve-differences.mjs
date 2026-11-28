import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [reportRoot, outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error("Usage: node c1-resolve-differences.mjs REPORT_ROOT OUTPUT_JSON");
const here = dirname(fileURLToPath(import.meta.url));
const read = path => JSON.parse(readFileSync(path, "utf8"));
const slash = value => value.replaceAll("\\", "/");
const pending = new Map();
for (const label of ["focused", "full"]) {
  for (const test of read(join(here, `c1-${label}-comparison.json`)).additional) {
    const key = `${test.file} :: ${test.name}`;
    const previous = pending.get(key);
    pending.set(key, { file: test.file, name: test.name, initialFailures: [...(previous?.initialFailures ?? []), label] });
  }
}
const evidence = [
  { candidate: "c1-full-fixes.json" },
  { candidate: "c1-full-paired-differences-candidate.json", baseline: "c1-full-paired-differences-baseline.json" },
  { candidate: "c1-paired-differences-candidate.json", baseline: "c1-paired-differences-baseline.json" },
].map(item => ({ ...item, candidateReport: read(join(reportRoot, item.candidate)),
  baselineReport: item.baseline ? read(join(reportRoot, item.baseline)) : undefined }));
function status(report, test) {
  if (!report) return undefined;
  const matches = report.testResults.filter(suite => slash(suite.name).endsWith(`/${test.file}`))
    .flatMap(suite => suite.assertionResults).filter(assertion => slash(assertion.fullName) === test.name);
  if (matches.length > 1) throw new Error(`Ambiguous assertion: ${test.name}`);
  return matches[0]?.status;
}
const cases = [...pending.values()].map(test => {
  for (const item of evidence) {
    const candidateStatus = status(item.candidateReport, test);
    if (candidateStatus !== "passed" && candidateStatus !== "failed") continue;
    const baselineStatus = status(item.baselineReport, test);
    return { ...test, candidateStatus, baselineStatus, evidence: item.candidate,
      resolution: candidateStatus === "passed" ? "passed-after-rerun-or-correction"
        : baselineStatus === "failed" ? "reproduced-on-baseline" : "unresolved" };
  }
  return { ...test, resolution: "unresolved" };
});
const summary = { total: cases.length,
  passed: cases.filter(test => test.resolution === "passed-after-rerun-or-correction").length,
  reproducedOnBaseline: cases.filter(test => test.resolution === "reproduced-on-baseline").length,
  unresolved: cases.filter(test => test.resolution === "unresolved").length };
writeFileSync(outputPath, JSON.stringify({ summary, cases }, null, 2) + "\n");
console.log(JSON.stringify(summary));
if (summary.unresolved) process.exitCode = 1;
