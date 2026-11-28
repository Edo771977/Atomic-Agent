# W2.2: scheduler handover and pinned tool bodies

Status: current
Owner: docs/reviews/

Base: fork `origin/main` at `54f81900b9220268e6f88a8276d00feb4769f603`, fetched on 28 November 2026. Origin is `https://github.com/Edo771977/Atomic-Agent.git`; upstream is `https://github.com/AtomicBot-ai/atomic-agent.git`. This branch targets main directly, without stacking on C1 or export. Follow-up to #233 and the w8–w10 triage.

## Imports and adaptations

The tests were applied and committed before production changes. Both upstream commits were then imported separately with `git cherry-pick -x`:

| Source | Imported commit | Behavior |
| --- | --- | --- |
| `657187d267a4aa7aa3aadded96491afd5b6e953f` | `e445188ea` | With a leadership gate, drain on acquisition but wait one interval tick before starting sidecars. |
| `ace8e9d2760e2ee56c2bc18f9661c08b646b8c24` | `2e57e6e7e` | Bound oversized tool results in the suffix restored by user/task pins; retain the stored transcript. |

No textual conflicts occurred. The upstream test hunks were already present from the test-first commit, so the cherry-picks retain their source trailers while their new diffs contain production/documentation changes only.

Two behavioral conflicts appeared in tests against the fork and are corrected separately:

- **Existing render caps remain ceilings.** The direct upstream port cuts stored shell summaries from the tail. A fresh `gog` shell result previously rendered its head; that port revealed previously hidden rows from its tail. The fork now bounds the existing rendered body, retains each tool's head/tail convention, and accepts a replacement only when its rendered character count does not increase and its estimated token cost decreases.
- **Repeated reads remain pointers.** Repeat detection compares both file identity and summary text. Bounding only the first read made the later original summaries different, turning pointers back into full bodies. Each repeated copy now carries the same projected cut as its preceding copy. Stored turns remain unchanged; identity checks are not relaxed.

The acceptance guard also preserves short bodies when truncation overhead would enlarge them. A separate regression against the direct upstream port increases a 250-character body to 316 characters at a tiny budget; the fork leaves that body unchanged. The tiny budget does not authorize adding prompt content.

The per-body cap is derived from the existing low-water budget. Pair limits, held cuts, user/task pins and dropped-summary reserve are unchanged. This is a reduction of oversized tool bodies, not a universal hard ceiling on arbitrary user text, call arguments or many simultaneous pinned results. No new spill is created by packing; cloud journal assembly retains its existing separate path.

## Tests before code

Compact, reproducible results are recorded in [w2-verification.json](w2-verification.json).

| Invariant | Evidence before production change |
| --- | --- |
| Sidecars wait through owner handover | Both upstream sidecar tests fail; the added real-lock test fails before the owner handover assertions because the initial leader already starts twice. The final test asserts the real lock PID before each sidecar and preserves Telegram owner priority. |
| Huge pinned bodies shrink | HTTP costs 25,236 estimated tokens against 2,000; shell costs 2,339 against 1,000. Three upstream overflow assertions fail. |
| Existing rendered content never widens | The matrix passes on main, then fails on the direct upstream port by finding `row 1998` absent from the original `gog` head. It passes after adaptation. |
| Truncation overhead cannot expand a short body | The direct upstream port fails with 316 characters against the original 250; the final guard test passes. |
| Repeated reads stay pointers | Main fails the bounded-size assertion (8,509 serialized characters). Direct upstream fails the pointer assertion. Adaptation passes both. |
| Spill and incognito remain intact | Both combined tests fail the reduction assertion on main. After port, the prompt shrinks, the original spill file stays byte-identical, packing adds no files, and incognito creates none. |
| Stable prefix and section order | Before port, the combined prompt test fails with 39,213 conversation tokens against 2,000. After port it passes, including byte equality of the stable prefix and lessons following conversation. |

The tests use disposable state directories and fake tool results, with no external inference or network calls.

## Reserved areas and W2.1 deferral

On 28 November, #281 and C1 #298 are open. W2.2's code files have no intersection with either PR's changed-file list. The only shared file with #281 is `docs/user/fork-differences.md`, where this change adds its own paragraph. Triage changes are limited to #1868 and W2.2. No export, crawl, name resolution, worker runner, profiles or subagent code is changed.

W2.1 is **not imported**. All three #1761 commits (`f6068f482`, `10f775bbf`, `940e9f45a`) must remain together, and they touch `src/runtime/composition/runtime-turn-service.ts` and its test, both changed by C1 #298. Under the requested file-overlap rule, no W2.1 PR is opened. #1841 (`377cb0cf1`) remains with that lifecycle series rather than being presented as completed separately.

After C1 lands, restart W2.1 from freshly fetched origin/main. Still required: distinguish serve quit from user Stop; preserve typed and scrubbed errors; resume shutdown-interrupted tasks without marking them user-interrupted chats; give the next sidecar turn a fresh signal; verify cancellation during lock acquisition and cancellation of child processes/network calls at dispatch. Preserve public `runTurn` and the already-locked `executeTurn` seam without recursive enqueueing. None of those unperformed checks is claimed as passing here.

## Validation

Validation results are recorded in [w2-verification.json](w2-verification.json). The requested broad selection is reported separately from focused tests; failures from Windows permissions or existing main behavior are retained with their comparison evidence.

Pass: `npm ci`, `npm run lint`, `npm run imports:check`, `npm run typecheck:tests` and `npm run docs:check`. Imports have zero runtime cycles and exceptions; test types add no errors to the existing 669 diagnostics. The focused final selection passes 122 tests, and the additional final packer guard run passes all six tests. The spill suite passes after granting the permissions its Windows link fixtures require; its earlier three EPERM failures remain recorded.

The required command `npx vitest run src/runtime src/sidecar src/cli src/scheduler src/session src/tasks src/agent/turn` completed with **4,233 passed, 21 failed and 33 skipped**, across 379 files. It was run with default and JSON reporters under the permissions needed by the Windows fixtures. The earlier restricted execution was interrupted by the environment before producing its final report; it remains explicitly incomplete.

All 21 failing names were compared against the same main SHA. Nineteen fail on main too, in the existing Windows link, ACL, path, stdin/authentication, skill-history and egress-guard tests. The other two are real-process skill installation and channel startup: both pass on main, and both pass on W2 when rerun with one worker and their original timeouts. The channel failure includes a hook timeout. There are zero unclassified failing names, no timeout increases and no new exclusions. These focused comparisons do not turn the full suite green; its original non-green result is retained.
