/**
 * Test runner output read into cases and totals (issue #102): a leaf
 * module, so the contract checks and the execution evidence can both
 * read a run's cases without importing each other.
 */

/** One test case as the run reported it. */
export interface ExecutedTest {
  name: string;
  ok: boolean;
  skipped?: true;
}

/** Cases kept per run, and characters per case name. */
export const MAX_TESTS = 60;
const MAX_NAME = 120;

/**
 * The cases and totals in a test runner's output: TAP (`ok 1 - name`,
 * `not ok 2 - name`, `# pass 9`) and `node --test`'s spec reporter
 * (`✔ name (1ms)`, `✖ name`, `ℹ pass 9`). Subtests are kept as their own
 * lines; a `# Subtest:` header is not a case. Nothing found: no tests.
 */
export function parseTestOutput(text: string): { tests: ExecutedTest[]; counts?: { pass: number; fail: number; total: number } } {
  const tests: ExecutedTest[] = [];
  const totals: Record<string, number> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const tap = /^(not ok|ok)\s+\d+(?:\s+-)?\s*(.*?)\s*(?:#\s*(SKIP|TODO)\b.*)?$/i.exec(line);
    if (tap !== null) {
      const name = (tap[2] ?? "").trim();
      if (name.length > 0) tests.push({ name: name.slice(0, MAX_NAME), ok: tap[1]!.toLowerCase() === "ok", ...(tap[3] === undefined ? {} : { skipped: true as const }) });
      continue;
    }
    const spec = /^([✔✓✖✗﹣-])\s+(.+?)(?:\s+\([\d.]+\s*m?s\))?(?:\s+#\s*(SKIP|TODO)\b.*)?$/u.exec(line);
    if (spec !== null && spec[1] !== "-" && spec[1] !== "﹣") {
      tests.push({ name: spec[2]!.slice(0, MAX_NAME), ok: spec[1] === "✔" || spec[1] === "✓", ...(spec[3] === undefined ? {} : { skipped: true as const }) });
      continue;
    }
    const total = /^(?:#|ℹ)\s*(tests|pass|fail)\s+(\d+)\s*$/u.exec(line);
    if (total !== null) totals[total[1]!] = Number(total[2]);
  }
  // A suite line (spec reporter) repeats its cases' outcome: keep the
  // cases, which come before it, and drop a later duplicate name.
  const seen = new Set<string>();
  const unique = tests.filter((t) => {
    const key = `${t.name}\u0000${t.ok}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const counts = totals.pass !== undefined && totals.fail !== undefined
    ? { pass: totals.pass, fail: totals.fail, total: totals.tests ?? totals.pass + totals.fail }
    : undefined;
  return { tests: unique.slice(0, MAX_TESTS), ...(counts === undefined ? {} : { counts }) };
}
