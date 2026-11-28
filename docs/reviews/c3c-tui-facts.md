# C3c: terminal facts review

Status: current
Owner: docs/reviews/

Deferred under #233 because [C3a](c3a-user-facts.md) and [C3b](c3b-import-jobs.md) remain deferred. No production TUI integration is imported. The PR starts from C3b's deferral branch.

## Candidate and reproduction

Run [c3-prepare-candidate.ps1](c3-prepare-candidate.ps1) with `-Through c`, then `npm ci` in that disposable candidate. After the C3a/C3b picks, `git cherry-pick -x e0d2d6dfc6743cf26bea823429298b21e92bc89f` applies without conflicts. The fork's existing TUI composition is retained by the clean merge. These production changes remain in the isolated review checkout only.

Set C3_CANDIDATE_ROOT and run `node --import tsx --test docs/reviews/c3c-candidate.mjs` from this branch. The [audit](c3c-candidate.mjs) loads the real candidate state/reducer/key handler and renders the real view using Ink with 12 synthetic candidates. No model, real export or personal memory is used. Renderers are unmounted and cleaned up.

The [candidate output](c3c-candidate.log) records **6 tests: 3 pass, 3 fail**:

- Receiving candidates selects all of them, contrary to the required default of saving none.
- Enter immediately emits a save command containing all approved IDs without a single explicit checkbox action.
- With a six-row review area, the first rendered page contains only three facts, but Enter approves all 12. Thus facts the person has not seen can be saved from that page.

Passing controls show a visible fact and its backing quote, Esc issues a close/discard rather than a save, and opening a fresh run clears cloud consent. The upstream reducer/key/view suites pass (11 tests); with the C3d hint controls, [the candidate summary](c3cd-upstream-tests.json) records 13 passes. Those original expectations include the all-selected default, so they do not enforce this fork's approval contract.

The [absence regression](../../src/tui/import/facts-review-deferred.test.ts) fails on the candidate ([red report](c3c-absence-red.json)) and passes on the deferral. It covers both missing feature owners and absence of the facts-step state in the established import form. This is candidate-red/deferral-green evidence.

The preparation script copies the available slices' absence tests into the candidate after the provenance-bearing cherry-picks, leaving them untracked. In that candidate, `npx vitest run src/tui/import/facts-review-deferred.test.ts` reproduces the three red assertions. The upstream feature source remains unchanged by these copied tests.

The [independent preparation check](c3-reproduction.json) ran the script through all six picks into a second new checkout. Its committed tree is identical to the original candidate (`68925457730e315d2df9d0e50195307fa82cdc92`); npm ci succeeds, the TUI audit again has three passes/three failures, and the 14 available C3a/C3b/C3c absence assertions are all red. The later C3d PR supplies its two additional absence assertions.

## Before reopening

First complete C3a/C3b's archive, secret, memory, model-policy and person-approval tests. Then add failing tests before adapting this UI:

- Default every candidate to unchecked. Saving requires deliberate approval of exact facts; opening, receiving results, moving a cursor, pressing Enter on an untouched review and retrying cannot select them implicitly.
- Display each fact and its backing quote before it can be approved. Test scrolling, long content, small terminals, keyboard/mouse parity and saves involving facts off the current page. No inference result is an instruction or an approval.
- Bind selection to the exact job/candidates; drop late results after close/navigation and dispose the actual job, not just the polling timer. Stop must cancel reading/inference and leave no delayed save.
- Preserve fresh per-run cloud consent and this-computer endpoint classification. Surface refusals without candidate text or credentials in durable notices, logs or reports.
- Exercise the runner against real scoped/disabled stores, explicit person approval, receipts and undo. Pure view/reducer tests do not establish those service boundaries.

See [verification](c3c-verification.json) for required setup/static/focused checks. No policy, agent/step, Fusion, subagent or chat-export implementation is changed.

Setup, lint, imports:check, typecheck:tests and docs:check pass. The entire requested six-area selection records 12,391 passes, one failure and 12 skips; all three new assertions pass. The [name comparison](c3c-focused-comparison.json) matches the sole VoteStore timing failure to clean main, with no additional focused failure. The full-suite comparison follows in C3d.
