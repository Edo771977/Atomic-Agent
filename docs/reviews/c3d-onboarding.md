# C3d: first-run export hint

Status: current
Owner: docs/reviews/

Deferred under #233 solely because the preceding [C3c facts step](c3c-tui-facts.md), [C3b service](c3b-import-jobs.md) and [C3a extraction](c3a-user-facts.md) are deferred. No intrinsic unsafe behavior was found in the hint itself. No production onboarding change is imported. The PR starts from C3c's deferral branch.

## Candidate and reproduction

Use [c3-prepare-candidate.ps1](c3-prepare-candidate.ps1) with `-Through d`, then `npm ci` in that candidate. The last pick is `git cherry-pick -x 89aecbec047767d2a15e92ee11812045a7510ef1`; it applies without conflict after C3c. All six upstream commits remain separate provenance-bearing review commits, with only the C3b capability conflict resolution documented there.

Set C3_CANDIDATE_ROOT and run `node --import tsx --test docs/reviews/c3d-candidate.mjs` from this branch. The [audit](c3d-candidate.mjs) imports and renders the actual onboarding pick component with a synthetic detected-agent list. It observes the real job-start and durable-store methods, which would throw if rendering called them, and checks an empty disposable state directory.

The [output](c3d-candidate.log) records **3/3 controls passed**: the hint names ChatGPT and Claude and the facts destination, its measurement includes the full hint, and rendering starts no import and writes no fact or state file. The original two hint tests also pass ([candidate suite summary](c3cd-upstream-tests.json)). This proves render-time informational behavior, not a completed end-to-end first-run or import workflow.

Shipping the text now would direct the person to `/import › Facts about you`, a destination intentionally absent while its prerequisites are deferred. The requested dependency rule therefore holds this slice back as well. This is not presented as a security defect in informational copy.

The [absence regression](../../src/tui/onboarding/chat-export-hint-deferred.test.tsx) is red on the candidate ([report](c3d-absence-red.json)) and green on this branch. It checks that the current onboarding does not advertise the absent facts destination. Before enabling the hint, first finish the predecessor guarantees, then keep the informational-only render test and test that the advertised destination actually opens the approved flow without starting an import automatically.

## Verification

Required setup, static checks and the complete requested six-area selection are recorded in [verification](c3d-verification.json). The full `npm test` run is compared by failed test name with clean main at the pinned initial base; original failures and any paired controls remain in the evidence. No full-green claim or unrelated production repair is made.

Both complete runs use `npm test -- --maxWorkers=6 --reporter=json --outputFile=<report.json>`, with no quarantine or added exclusion. The final run uses a dedicated verification checkout containing all four new regression files. Its [source comparison](c3d-source-comparison.json) matches this branch's 5,360 non-Markdown source, grammar, script, package/lock and TypeScript/Vitest configuration files byte for byte. The shared SHA-256 is `b8d9482fc7a03c676c86434ac351e5e184b95ae3aaa5a352be811f7e0e8df873`; production sources are unchanged from main.

To reproduce the comparison, use [c3-compare-tests.mjs](c3-compare-tests.mjs): `node docs/reviews/c3-compare-tests.mjs <main-report.json> <final-report.json> <main-checkout> <final-checkout> <comparison.json>`. It keys failures by relative file and full test name, normalizing only checkout roots. [c3-source-inventory.mjs](c3-source-inventory.mjs) accepts a checkout and output JSON path to reproduce the source digest. Markdown documentation is covered separately by docs:check.

The complete clean-main run records **30,921 passed, 85 failed, 660 skipped**. The final C3 run records **30,891 passed, 131 failed, 660 skipped**; all 16 new absence assertions pass. The [original full comparison](c3d-full-comparison.json) preserves 84 common failed names, 47 initially additional names and one main failure that passes here. Of the 47 additional cases, 46 ran for at least 15 seconds; the remaining managed-key recovery assertion exceeded its one-second bound. This timing evidence does not by itself establish the cause.

The [additional-name runner](c3-run-additional-controls.mjs) reruns exactly the comparison's additional names with unchanged timeouts. Paired two-worker controls of all 47 record 35 passes and 12 failures on each checkout, with eight common failures and four different failed names on each side ([control comparison](c3d-controls-comparison.json)). Their 268 other cases are pending only because of the name filter; neither complete run excludes them. Original failures remain visible rather than being replaced by the controls.

The four remaining C3-only names from those controls were run once more, first on main and then on C3d, with one worker and no timeout change. All four pass on both ([serial comparison](c3d-serial-comparison.json)); the 50 other cases in those files are filtered-control skips. No additional failed name remains unresolved after these controls. This is not a claim that the original complete run was green or that existing Windows/timing failures were repaired. The source inventory remains identical after the full run.

Final npm ci, lint, imports:check, typecheck:tests and docs:check pass. The requested six-area selection records **12,393 passed, one failed, 12 skipped**. Its sole VoteStore timing failure matches main, with [no additional focused failure](c3d-focused-comparison.json); both new C3d assertions and all 14 predecessor assertions pass.

Only this slice's Ondata C row, user guide, onboarding README, absence test and review evidence change relative to C3c. All protected parallel-work areas remain byte-identical to the initial main.
