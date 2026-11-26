# B4c review: Composio accounts

Status: current
Owner: docs/reviews/

[Verified upstream IDs, parents and disposition](b4c-upstream-commits.json).

Deferred together: upstream #1687 and #1688, commits `74d5d2de8`, `ad4080f05`, `0c5cb70fc`, in that order. No production code or upstream commit is imported. Baseline: fork main `2fa1eb9a4fa14987610f74f15b361467fe26a18c`, Windows, Node v26.13.1, `npm ci`. Organization policy #246 was open and unmerged on 26 November 2026.

## Observed blockers

The [candidate tests](b4c-candidate-tests.patch) were authored before copying the CLI and prompt implementation. **2 assertion failures**: changing the default account changes the stable-prefix bytes, and an `ATOMIC_AGENT_TOOL_CHILD=1` CLI command calls connected-account listing. The latter test injects the network seam and returns a synthetic personal email; it sends no external request. Its assertion fails because account listing runs rather than being refused before credentials/accounts are consulted.

The prefix test calls the actual `buildStablePrefix` with a valid Composio descriptor and identical inputs except account default flags. Candidate #1687 explicitly adds `composio.accounts` to that cached prefix. #1688 then adds live account editing/remounting in the hub. Keeping this combination requires a session-owned stable snapshot or moving mutable hints after conversation, plus privacy handling of personal aliases. A prefix-only fix would leave the new CLI account and credential boundary open; this import is deferred as one unit.

## Reproduction

Use a disposable checkout of this PR, dependencies installed and upstream objects fetched. The snapshots exercise components only; they do not register the command or TUI actions.

```powershell
git apply docs/reviews/b4c-candidate-tests.patch
git show 74d5d2de8:src/cli/composio-command.ts | Set-Content -Encoding utf8 src/cli/composio-command.ts
git show 74d5d2de8:src/prompt/composio-guidance.ts | Set-Content -Encoding utf8 src/prompt/composio-guidance.ts
git show 74d5d2de8:src/prompt/stable-prefix.ts | Set-Content -Encoding utf8 src/prompt/stable-prefix.ts
npx vitest run src/cli/b4c-candidate.test.ts src/prompt/b4c-candidate.test.ts
```

The passing production regressions `src/cli/composio-accounts-deferred.test.ts` and `src/prompt/composio-accounts-deferred.test.ts` check the real offline child CLI rejection without input disclosure or new state, absent CLI/TUI owners, the actual integration descriptor, and byte equality with a personal account hint before/after selection on grammar and native-tool transports. Existing account configuration and session pins from ATO-548 remain unchanged.

## Before reopening

- Keep mutable account hints after conversation and keep session/role stable-prefix bytes identical before/after an account edit. Mask personal aliases/IDs before any cloud provider sees them, including with Privacy Shield disabled where credentials are involved.
- Refuse marked-child account read/write/delete through CLI, TUI entry points, HTTP with an inherited owner key, credential owners/files and MCP. Preserve non-grantable trust decisions and both protected inventories.
- Bind Composio credentials only to its official origin; test foreign base URL, userinfo, trailing dot and `localhost.`. Offline must initiate no account verification or login; incognito must create no durable account state.
- Search all model/prompt/history/memory/transcript/trace/error/log/Sentry/analytics sinks for a sentinel after success and failure. Existing plaintext configuration and network seams are not made safe merely by omitting the prompt line.
- Any new HTTP route requires serve authentication and explicit admin scope for viewer/member/operator/admin tests, with no value-reading route. Apply #246 when merged, and retain folder/provider policy and Privacy Shield per-call archives.

The final B4 PR records the complete-suite comparison against the same main by file and test name. Disabled surface tests establish absence, not the security of future enabled account editing.

## Verification results

The [machine-readable comparison](b4c-verification.json) preserves failures by file and full test name. Only the absolute checkout prefix in parameterized test names is normalized. All four required static/documentation checks pass. The requested focused suite reports **14,490 passed, 29 failed, 572 skipped**; all **3 new absence tests pass**. Main's complete baseline run reports **30,507 passed, 67 failed, 658 skipped**.

There are 21 focused failures with the same name in main's complete run. Additional names and their targeted main/candidate reruns are listed separately, including the three EBUSY cleanup cases. Other differing names either also fail on main or pass on both checkouts in the targeted rerun. The comparison does not claim an entirely green suite. All 15 new B4 absence tests also pass together on updated main `2ce8742c9` after #259, with only test files copied and no production changes.
