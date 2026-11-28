import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Only synthetic fixtures run. No server or worker is started. fetch is replaced.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] ?? process.env.B7B3_CANDIDATE_ROOT ?? "");
if (!process.argv[2] && !process.env.B7B3_CANDIDATE_ROOT) throw Error("Supply the disposable candidate checkout path");
const target = join(root, "src/runtime/composition/b7b3-candidate-review.test.ts");
if (existsSync(target)) throw Error("Refusing to replace an existing candidate test");
writeFileSync(target, readFileSync(join(here, "b7b3-candidate.fixture.ts")), { flag: "wx" });
try {
  const run = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "src/runtime/composition/b7b3-candidate-review.test.ts", "--reporter=json", "--outputFile=" + resolve(process.argv[3] ?? "b7b3-candidate.json")], { cwd: root, stdio: "inherit", windowsHide: true });
  if (run.error) throw run.error;
  process.exitCode = run.status ?? 1;
} finally { unlinkSync(target); }
