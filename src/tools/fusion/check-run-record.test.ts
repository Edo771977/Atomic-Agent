/**
 * Issue #104 review: a command check's run as the reviewer gets it.
 * stdout (where TAP is) and stderr have separate budgets, so a long
 * stderr never pushes the TAP out.
 */
import { describe, expect, it } from "vitest";

import { CHECK_RUN_OUTPUT_CHARS, CHECK_RUN_STDERR_CHARS, checkRunOf } from "./contract-checks.js";

const TAP = ["TAP version 13", ...Array.from({ length: 9 }, (_, i) => `ok ${i + 1} - case ${i + 1}`), "1..9", "# pass 9", "# fail 0"].join("\n");
const check = { task: "t", kind: "command", cmd: "node", args: ["--test", "a.cjs"] };

describe("checkRunOf clipping (issue #104 review)", () => {
  it("a long stderr keeps the TAP whole and is cut to its share", () => {
    const run = checkRunOf(check, { ok: true, stdoutTail: TAP, stderrTail: "warning: x\n".repeat(2_000), exitCode: 0 })!;
    expect(run.output).toContain("TAP version 13");
    expect(run.output).toContain("# pass 9");
    expect(run.output.length).toBeLessThanOrEqual(CHECK_RUN_OUTPUT_CHARS + 20);
    // stderr takes what stdout leaves of the budget.
    expect(run.output.split("--- stderr ---\n")[1]!.length).toBe(CHECK_RUN_OUTPUT_CHARS - TAP.length);
    // Both long: stderr gets its share, stdout the rest.
    const both = checkRunOf(check, { ok: true, stdoutTail: `${"y".repeat(20_000)}\n${TAP}`, stderrTail: "warning: x\n".repeat(2_000), exitCode: 0 })!;
    const [out, err] = both.output.split("\n--- stderr ---\n");
    expect(err!.length).toBe(CHECK_RUN_STDERR_CHARS);
    expect(out!.length).toBe(CHECK_RUN_OUTPUT_CHARS - CHECK_RUN_STDERR_CHARS);
    expect(out!.endsWith("# fail 0")).toBe(true);
    expect(run.clipped).toBe(true);
    expect(run.tests).toHaveLength(9);
  });

  it("a long stdout keeps its tail; a short output is whole and not clipped", () => {
    const long = checkRunOf(check, { ok: true, stdoutTail: `${"x".repeat(20_000)}\n${TAP}`, exitCode: 0 })!;
    expect(long.output.endsWith("# fail 0")).toBe(true);
    expect(long.output.length).toBe(CHECK_RUN_OUTPUT_CHARS);
    expect(long.clipped).toBe(true);
    const short = checkRunOf(check, { ok: true, stdoutTail: TAP, exitCode: 0 })!;
    expect(short.output).toBe(TAP);
    expect(short.clipped).toBeUndefined();
  });
});
