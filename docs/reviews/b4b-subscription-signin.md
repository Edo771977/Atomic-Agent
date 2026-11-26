# B4b review: ChatGPT and Copilot sign-in

Status: current
Owner: docs/reviews/

[Verified upstream IDs, parents and disposition](b4b-upstream-commits.json).

Deferred as a chain: upstream #1578, #1579 and #1707. No production code or upstream commit is imported. Reviewed on fork main `2fa1eb9a4fa14987610f74f15b361467fe26a18c`, Windows, Node v26.13.1, dependencies from `npm ci`. Organization policy #246 was open and unmerged on 26 November 2026.

## Exact chain

Use the branch rows of the triage, not the second parent alone. The requested order is:

- #1578: `0a29ff1aa`, `b5e2ad661`, `21a3b583a`, `d54d0ff10`, `e91d8b6aa`, `afafac34a`.
- #1579: `6b92916fa`, `30f565d19`, `2b9d196e2`.
- #1707: `32b2a43ac`, `e83daa15d`.

Skip merge commits `d97dd97fe`, `bf7e30572`, `29ee10357`. None is imported. The evidence below exercises the credential-store snapshot at `e83daa15d`; it is not a claim that the entire chain has been integrated or tested end to end.

## Observed blocker

The [candidate tests](b4b-candidate-tests.patch) were authored before copying the candidate credential store. Result: **1 passed, 6 failed**, all assertion failures. The operator can load and clear a synthetic token. A marked agent child can also load and clear both `auth/chatgpt.json` and `auth/copilot.json`. Neither the trust inventory nor the state-secret inventory protects the new token path. The tests use actual temporary files, not mocked persistence.

Owner-only filesystem permissions protect against other users; they do not exclude the agent child running as the owner. Importing this store and then wiring automatic refresh would add a privileged path before that boundary exists. The generic OAuth primitives already in main remain unwired and are outside this deferral; existing external subscription CLI seats remain available.

## Reproduction

Use a disposable checkout of this PR, dependencies installed, upstream commit objects fetched:

```powershell
git apply docs/reviews/b4b-candidate-tests.patch
git show e83daa15d:src/llm/provider/subscription-oauth/credential-store.ts | Set-Content -Encoding utf8 src/llm/provider/subscription-oauth/credential-store.ts
npx vitest run src/llm/provider/subscription-oauth/b4b-candidate.test.ts
```

The normal-suite regression is `src/llm/provider/subscription-oauth/subscription-signin-deferred.test.ts`. It checks the actual provider registry, the absence of service adapters/store, and launches the real CLI for ChatGPT/Copilot login/logout as an offline marked child. Stdin contains only a synthetic sentinel; the command rejects the feature without echoing it or creating state.

## Before reopening

- Keep experimental direct sign-in disabled by default behind an explicit flag. Use validated owner-only storage, protect every token path in both inventories and exclude child read/write/delete/refresh through CLI, HTTP with an inherited key, file owners and MCP. Logout must remove the real stored record.
- Verify official origins for all access/refresh/device/API exchanges. Include foreign base URLs, userinfo, trailing dots and `localhost.`. Callback listeners must use loopback only, verify state, and close after success, failure, cancellation and expiry.
- Offline must initiate no login, refresh or verification. Route ChatGPT and Copilot cloud inference through Privacy Shield with per-call archives (#245/#250), including overlapping calls. Incognito must persist no new state.
- Test sentinels after success and failure in model requests, prompt/history, memory, transcripts, traces, displayed errors, logs, Sentry and analytics. The absence tests do not certify an enabled provider's sinks.
- The CLI-like fallback from `d54d0ff10` must respect `projects.constraints` and provider policy before another provider sees a prompt. Any new HTTP route needs serve authentication and explicit admin scope, tested for all four named roles; no route may read a key value. Apply #246 once merged.

The final B4 PR records the complete-suite comparison by file/test name against this same main baseline.

## Verification results

The [machine-readable comparison](b4b-verification.json) preserves failures by file and full test name. Only the absolute checkout prefix in parameterized test names is normalized. All four required static/documentation checks pass. The requested focused suite reports **14,483 passed, 36 failed, 572 skipped**; all **3 new absence tests pass**. Main's complete baseline run reports **30,507 passed, 67 failed, 658 skipped**.

There are 21 focused failures with the same name in main's complete run. Additional names and their targeted main/candidate reruns are listed separately, including the three EBUSY cleanup cases. Other differing names either also fail on main or pass on both checkouts in the targeted rerun. The comparison does not claim an entirely green suite. All 15 new B4 absence tests also pass together on updated main `2ce8742c9` after #259, with only test files copied and no production changes.
