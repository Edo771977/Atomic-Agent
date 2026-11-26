# B4d review: Monid integrations row

Status: current
Owner: docs/reviews/

[Verified upstream IDs, parents and disposition](b4d-upstream-commits.json).

Deferred: upstream #1573, commits `cb16265b4`, `710540e3c`, `626104ff0`, in order. No production code or upstream commit is imported. Baseline: fork main `2fa1eb9a4fa14987610f74f15b361467fe26a18c`, Windows, Node v26.13.1, `npm ci`. Organization policy #246 was still open and unmerged on 26 November 2026.

## Observed blocker

The [candidate tests](b4d-candidate-tests.patch) were written before copying the candidate descriptor. **1 passed, 4 failed**, all assertion failures. The official catalog URL is recognized under another local name (control). A server named `monid` with a foreign URL is also selected: plain foreign host, userinfo, trailing dot and `localhost.` all fail rejection assertions. The candidate's `runMonidSignIn` delegates to the selected name's existing MCP sign-in. Therefore the new branded entry point is not pinned to Monid's official origin.

These tests demonstrate origin selection confusion; they do not claim that a real Monid token was sent to a foreign server. No browser, callback, external host or real credential is used. Import would expose a branded browser flow before its selected origin and credential lifecycle have been verified. Correcting only the displayed label would not establish those guarantees.

## Reproduction

Use a disposable checkout of this PR with dependencies installed and upstream commit objects fetched:

```powershell
git apply docs/reviews/b4d-candidate-tests.patch
git show 626104ff0:src/integrations/monid-integration.ts | Set-Content -Encoding utf8 src/integrations/monid-integration.ts
npx vitest run src/integrations/b4d-candidate.test.ts
```

This copies the pure descriptor/selector only, without registering the integration or TUI actions. The normal regression `src/integrations/monid-hub-deferred.test.ts` checks the actual integration registry and absence of both new implementation owners. The existing generic MCP catalog entry and OAuth operations are not removed or certified by this change.

## Before reopening

- Bind the branded entry point and every token exchange/refresh to the official origin, rejecting foreign URLs, userinfo, trailing-dot ambiguity and `localhost.`. Verify the generic OAuth callback is loopback-only, state-checked and closes after success/failure/expiry; disconnect must actually delete persisted credentials.
- Refuse child credential/account read/write/delete/refresh through CLI, TUI, HTTP even with an inherited serve key, credential owners/files and MCP. Add token paths to both protected inventories as for `serve-api.key`, and retain non-grantable trust approval.
- Offline must start no login/refresh/verification; incognito must write no new state. Preserve folder/provider policy and Privacy Shield per-call archives where cloud inference is involved.
- Search model requests, prompt/history, memory, transcripts, traces, displayed errors, logs, Sentry and analytics for a sentinel after success and failure. These absence/selector tests are not full sink coverage for enabled OAuth.
- Any new route must require serve authentication and explicit admin scope, with viewer/member/operator/admin tests and no read-value route. Apply organization policy once #246 merges.

The complete-suite comparison with main is recorded alongside the final verification results. The isolated candidate snapshots do not substitute for an end-to-end imported chain.

## Verification results

The [machine-readable comparison](b4d-verification.json) preserves failures by file and full test name. Only the absolute checkout prefix in parameterized test names is normalized. All four required static/documentation checks pass. The requested focused suite reports **14,486 passed, 31 failed, 572 skipped**; the **new absence test passes**. Main's complete baseline run reports **30,507 passed, 67 failed, 658 skipped**.

There are 21 focused failures with the same name in main's complete run. Additional names and their targeted main/candidate reruns are listed separately, including the three EBUSY cleanup cases. Other differing names either also fail on main or pass on both checkouts in the targeted rerun. The comparison does not claim an entirely green suite. All 15 new B4 absence tests also pass together on updated main `2ce8742c9` after #259, with only test files copied and no production changes.

`npm test` was run to completion on this final PR: **30,511 passed, 64 failed, 658 skipped**. The nested full comparison contains every common, additional and baseline-only failure by name, alongside the baseline SHA.

Of the 64 full-suite failures, 53 have the same name in main's complete run and the 11 additional names are covered by the recorded main or paired reruns. Fourteen failures from main pass in this run. No production source is imported.
