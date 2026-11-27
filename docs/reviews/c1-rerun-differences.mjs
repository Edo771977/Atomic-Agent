import { closeSync, openSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const [baselineRoot, candidateRoot, outputPrefix, selectionPath] = process.argv.slice(2);
if (!outputPrefix) throw new Error("Usage: node c1-rerun-differences.mjs BASELINE_ROOT CANDIDATE_ROOT OUTPUT_PREFIX [SELECTION_JSON]");
const selection = JSON.parse(readFileSync(selectionPath ?? join(dirname(fileURLToPath(import.meta.url)), "c1-focused-rerun-selection.json"), "utf8"));
if (!Array.isArray(selection) || selection.length === 0) throw new Error("No selected test names");
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = selection.map(test => `^${escape(test.name)}$`).join("|");
const files = [...new Set(selection.map(test => test.file))];
for (const [label, root] of [["baseline", baselineRoot], ["candidate", candidateRoot]]) {
  const prefix = resolve(`${outputPrefix}-${label}`);
  const log = openSync(`${prefix}.log`, "w");
  let result;
  try {
    result = spawnSync(process.execPath, [join(resolve(root), "node_modules/vitest/vitest.mjs"),
      "run", "--maxWorkers=1", "--testNamePattern", pattern, ...files], {
      cwd: resolve(root), env: { ...process.env, ATAG_VERIFY_TEST_REPORT: `${prefix}.json` },
      stdio: ["ignore", log, log], windowsHide: true,
    });
  } finally { closeSync(log); }
  if (result.error || result.signal || result.status === null) throw result.error ?? new Error(`${label} interrupted: ${result.signal}`);
  console.log(`${label}: exit ${result.status}; ${selection.length} selected names; report ${prefix}.json`);
  process.exitCode = Math.max(process.exitCode ?? 0, result.status);
}
