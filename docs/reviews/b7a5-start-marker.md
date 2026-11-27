# B7a5 TUI start marker

Status: current
Owner: docs/reviews/

The missing prerequisite is ba8bf83430108512021948f72f33283519b55492, found by git log -S withChatStartPending in upstream main. It is a bounded lifecycle change (340 lines across 11 upstream files including tests/docs), with no policy implementation or agent step edit. It adds the PID marker owner/reader, wraps CLI and daemon starts, and projects start_pending into existing liveness/wait tags. Imported with -x before 499fc102f14fb915404bb6f16278f65eda3092a4, also with -x. Baseline: fork main 904476e2e099903833223beb4a0ace08b8d7a220.

The TUI regression was written first: a thrown backend start and shutdown cancellation both fail without the marker, and still fail with only the prerequisite. With both upstream commits, the existing-directory start/cancellation cases pass. A further first-start case without the model directory fails because marker creation silently skips ENOENT; the adaptation creates the directory before writing the marker. The marker is best effort on actual filesystem errors, matching upstream's failure-safe contract. It is removed in finally after success, failure or settled cancellation, and nested daemon starts share the reference count. Upstream tests check stale/dead owners, boot age and replacement markers. Tests use temporary state and synthetic starts, with no real model process.

Conflict resolution preserves the fork's live-owner/reused-PID ceilings and tests. Its lock-owner projection would incorrectly attach live ownership to a free-lock start_pending marker; the imported upstream test exposes that mismatch. The adaptation returns the process observation without a lockOwner for this branch, retaining the existing no-process ceiling. The recovery document conflict retains the richer fork explanation and adds the marker contract separately. No src/agent/step, src/policy, web crawl or Fusion promotion code changes.

## Verification results

The [verification record](b7a5-verification.json) preserves upstream provenance, red/green controls and initial attempts plus final retries. All final setup/static/documentation checks pass. The [name-by-name comparison](b7a5-comparison.json) uses the same main baseline and preserves every initial failure.

Requested focused suite: **12977 passed, 25 failed, 38 skipped**. 24 initial failures match main's complete run by file and full test name; 1 additional names are accounted for by the recorded controlled reruns. No additional failure remains unresolved. Every new test passes.

Complete npm test suite: **30653 passed, 94 failed, 658 skipped**. 91 initial failures match main's complete run by file and full test name; 3 additional names are accounted for by the recorded controlled reruns. No additional failure remains unresolved. Every new test passes.

Main's complete run: **30572 passed, 157 failed, 658 skipped**. A failed baseline test that passes here is recorded without attributing a fix to this feature. These reports do not claim an entirely green suite.

The three additional full-suite names are existing temporary-Git-fixture cases in candidate-integration and fusion-candidate. The selected paired rerun passes all three on this branch and main (3 passed, 107 unselected on each); no Fusion production code changes. These rerun results are preserved under controlledReruns in the comparison.
