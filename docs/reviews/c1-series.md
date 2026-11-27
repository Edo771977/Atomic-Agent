# C1 series verification

Status: current
Owner: docs/reviews/

This combined main-targeted change imports C1a-C1d and defers C1e under fork issue #233. The nine upstream commits retain individual cherry-pick -x provenance. Tests and fork adaptations have separate commits. No subagent execution tool is enabled.

## Scope and evidence

- [C1a](c1a-worker-depth.md): worker depth without dropping the fork's operator request or provider/egress/host stamps.
- [C1b](c1b-shared-runner.md): shared runner interfaces and subagent origin, preserving the fork's execution body and dispatch dependencies. The origin inventory includes the fork-only experience reviewer. This changes src/tools/fusion/worker-runner.ts, shared with parallel Fusion work.
- [C1c](c1c-settings-schema.md): settings schema/parser, notices and preservation of skipped entries.
- [C1d](c1d-profile-loading.md): fresh settings reads, runtime catalog admission and existing project trust. Complete local/cloud prompts retain identical stable-prefix bytes on an open session while reloaded instructions change subsequent briefs.
- [C1e](c1e-subagent-run.md): no production import. All fifteen upstream commits, after the six missing prerequisites, reproduce two hard-limit failures with three controls passing; all fifty upstream tests pass. The three absence assertions fail on that candidate and pass on the fork.

The [pre-import results](c1-fail-before.json) record the failing names before implementation. The requested broad selection additionally caught an exact worker-stamp expectation that omitted depth: 1. Only that expectation was corrected; the complete operatorRequest assertion remains exact and passes. A [paired rerun](c1-guard-pair-comparison.json) also reproduces the unchanged egress-guard failure on both main and C1.

The [adversarial review](c1-adversarial-review.md) records preserved controls and unimplemented execution requirements. This is not independent reviewer approval. Deferred approval routing, grant lifetime, process restrictions and whole-tree cancellation are reopening conditions, not behavior asserted by the imported prerequisites.

## Environment and source identity

Verification uses Windows, Node v26.13.1 and TypeScript 5.9.3, with disposable test state. Main's configured Windows limit of two workers and normal timeouts remain unchanged. No quarantine or exclusion was added. Restricted-environment partial attempts were stopped and replaced by the completed native runs reported below.

The comparison baseline is main 7511497b02504f81ffa03ec8f63367119fdaa6d8, containing B1. The first production candidate is c404acf178e289b680c3f480f8b8af6475a39ca1. Rebasing onto b68349f2b410cb6198576fc2db7b5f9f2ed430a8 adds only parallel C4 documentation and nine absence assertions, all nine independently passing. The [source parity record](c1-source-parity.json) verifies identical production through test strengthening at 79e97d2a0. After the broad run, 6410f5bcc9 refreshes one generated help description and adds the two worker tests to the mandatory Windows gate; no runtime function changes. Later main 5da6478ff7 adds documentation only, and merge-tree succeeds without rebasing over the parallel triage.

The fork origin and upstream URLs were verified. Every integration committer uses 209531336+Edo771977@users.noreply.github.com. The protected export files and the parallel crawl, tool-name-resolution and external llama.cpp probe implementations are untouched. Only the five C1 rows are changed in the triage.

## Required checks

npm ci, npm run lint, npm run imports:check, npm run typecheck:tests and npm run docs:check pass. Imports report zero cycles and exceptions. Test types have 672 explicit existing diagnostics, down from 674, with no new allowance. The final targeted selection passes 24 tests: fifteen C1 core/settings/depth/absence cases and nine parallel C4 absence cases. The strengthened settings-import selection passes all three tests, and the exact request/depth assertion passes.

The requested broad commands are run without exclusions:

```powershell
npx vitest run src/agent src/runtime src/policy src/approval src/tools src/config src/session src/llm src/prompt src/sidecar
npm test
```

The complete main run finishes with 34,799 passed, 193 failed and 663 skipped assertions across 2,647 files. Its native run lasts 4,548.06 seconds. It is not a green baseline.

The requested focused command finishes with 20,029 passed, 163 failed and 546 skipped assertions across 1,287 files. The [name comparison](c1-focused-comparison.json) records 129 common failures, 34 additional failures and seven baseline-only failures within the selection; 57 baseline failures are outside it. All sixteen explicitly named C1/core/origin assertions pass. The exact request/depth expectation among those 34 is corrected and passes its subsequent targeted run.

All 34 additional focused names were then rerun in sequence on main and C1 with one worker and unchanged timeouts. Main passes 32 and fails two cleanup operations; C1 passes 33 and fails one of those same cleanup cases. The [paired comparison](c1-paired-comparison.json) has zero additional candidate failures, one common ENOTEMPTY/EBUSY temporary-directory cleanup failure and one baseline-only failure. [Per-name statuses](c1-paired-results.json) verify that all 34 names ran exactly once on each branch. The exact whole-request assertion passes on both branches, with the new depth field required on C1. Neither run is described as wholly green.

Reproduce the paired selection with [c1-rerun-differences.mjs](c1-rerun-differences.mjs) and its [34 exact names](c1-focused-rerun-selection.json), after npm ci in both disposable checkouts:

```powershell
node docs/reviews/c1-rerun-differences.mjs BASELINE_ROOT CANDIDATE_ROOT OUTPUT_PREFIX
```

The final complete run starts at c43350e4ecafff2ed81897150515410498e097d4 and finishes with 34,925 passed, 148 failed and 663 skipped assertions across 2,657 files in 3,675.62 seconds. The [full name comparison](c1-full-comparison.json) records 126 common failures, 22 additional failures and 67 baseline-only failures. All sixteen tagged C1/core/origin assertions pass, including the strengthened prefix test, which loads after its update. The old request/depth expectation ran near suite startup before its test-only correction; the raw failure is retained and the later paired run verifies the corrected expectation.

Two additional failures are genuine check-maintenance omissions: C1d changes the schema JSDoc after C1c's generation, and the Windows scope inventory does not yet list the new core/origin files. Regenerating the reference outputs and adding both files as critical checks fixes them. All four affected test files pass (17 tests). No test is quarantined, deferred or given a longer timeout.

Thirteen of the full run's additional names already have later evidence in the 34-case pair. The seven other names are rerun with the same [driver](c1-rerun-differences.mjs) and a [second exact selection](c1-full-rerun-selection.json): all seven pass on both main and C1. The [second comparison](c1-full-paired-comparison.json) preserves that result. These include two timing-sensitive local-server/download cases and five Fusion fixtures; their production code is unchanged.

The [resolution matrix](c1-difference-resolution.json) accounts for the union of all 43 additional names: 42 pass after correction or rerun, one temporary-directory cleanup failure is reproduced on baseline, zero remain unexplained. Rebuild it from the saved report directory with [c1-resolve-differences.mjs](c1-resolve-differences.mjs):

```powershell
node docs/reviews/c1-rerun-differences.mjs BASELINE_ROOT CANDIDATE_ROOT OUTPUT_PREFIX docs/reviews/c1-full-rerun-selection.json
node docs/reviews/c1-resolve-differences.mjs REPORT_ROOT OUTPUT_JSON
```

The broad runs are deliberately reported as nonzero. Subsequent checks cover test-only corrections, one generated help description and the explicit Windows test list; the full suite is not represented as a second post-correction all-green run. [Machine-readable verification](c1-verification.json) links the counts and source identity.

Compare completed JSON reports by relative file and full assertion name with [c1-compare-tests.mjs](c1-compare-tests.mjs):

```powershell
node docs/reviews/c1-compare-tests.mjs BASELINE_JSON CANDIDATE_JSON BASELINE_ROOT CANDIDATE_ROOT OUTPUT_JSON
```

The comparison also retains collection/lifecycle failures, baseline failures outside a focused selection and bounded error evidence. It never treats a nonzero suite as passing. Platform errors and timing differences require baseline reproduction or paired rerun evidence before attribution.
