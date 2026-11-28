# W2.2 review corrections

Status: current
Owner: docs/reviews/

Follow-up to PR #300. Main `c9aaeedadad412242b00ed230da369ffb7223f81` was merged before these corrections in `9e11fc946`; the triage conflict keeps W2.2's PR link and main's W3.1/W3.2 results. Each review point has its own commit, including its regression test. Compact red/green results are in [w2-review-followup.json](w2-review-followup.json).

| Review point | Commit | Test that failed before the change |
| --- | --- | --- |
| 1. Lost shell spill pointer | `8c99bd341` | `keeps the shell spill pointer in the prompt at budget 500/1000`; both failed because the rendered result no longer contained the original spill line. The 2000-token case already fits and remains unchanged. |
| 2. Leadership timing | `2e417be26` | `poke cannot consume the interval that settles a new leader` failed because a sidecar started on the first interval after poke. `leadership loss aborts the old sidecar signal and reacquisition renews it` failed because the old signal was still active. |
| 3. Read paging | `f3fdd11aa` | `retains exact paging offsets and full hidden-line counts through a second read cut` failed because the numeric offset was absent. The test uses two batched reads with starts 101 and 501, and checks that shown plus hidden lines still totals 2000. |
| 4. Unicode boundaries | `8e84e6f2c` | Three `cuts ... only between complete Unicode characters` cases failed for HTTP, shell and file reads at a 1000-token budget. The final tests use a Unicode regex compatible with the project's TypeScript target. |

## Resulting behavior

An ordinary shell result that already shows its spill note keeps that complete first line while the packer retains its tail. Its context note directs the model to read the saved output, without asking it to repeat the command. Shell results without a spill also receive no instruction to rerun for missing output. The existing projection remains the ceiling: no hidden source bytes are restored, and a growing replacement is still rejected. Stored output, spill contents and incognito behavior are unchanged.

Only interval ticks can settle newly acquired sidecar ownership. `poke` may acquire leadership and drain tasks but leaves the first interval for settling. Each ownership period has its own AbortSignal; observing leadership loss aborts the old poll, and a later period receives a fresh signal. Owner priority and task-drain cancellation are unchanged.

This is cooperative cancellation and a timing mitigation. It does not provide cross-process fencing, wait for old polls to finish, roll back effects, force a stalled process to notice loss or stop a poll that ignores its signal. Different per-process `TASKS_SCHEDULER_TICK_MS` values or long polls can still overlap. The mail trigger's shared seen-ID read/modify/write can therefore still duplicate task creation. These limits are explicit in the [scheduler README](../../src/scheduler/README.md).

File reads keep their call-order offsets while packing. A second cut counts the original file lines rather than counting an earlier paging note as source text. Character cuts move inward around surrogate pairs, preserving complete Unicode code points and never increasing the retained body.

## Final validation

The required commands and the comparison against the merged main are recorded in [w2-review-followup.json](w2-review-followup.json). The original PR validation remains historical evidence in [w2-scheduler-packer.md](w2-scheduler-packer.md).

`npm run lint`, `npm run imports:check`, `npm run typecheck:tests` and `npm run docs:check` pass. There are no new type errors, import cycles or import exceptions; existing type debt stays at 669 diagnostics.

`npx vitest run src/scheduler src/session src/runtime` completed across 203 files with **2319 passed, 4 failed and 2 skipped**. Every failing name was rerun on the merged main SHA: all four fail there too (three Windows symlink EPERM cases in project instructions/trust, and the existing egress-guard assertion). The paired baseline selection has 42 passed, 4 failed and 1 skipped. No timeouts were increased, no tests excluded and no failing names remain unclassified. The broad suite is explicitly non-green.
