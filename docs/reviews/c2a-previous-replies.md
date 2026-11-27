# C2a: previous replies on regeneration

Status: current
Owner: docs/reviews/

Deferred under issue #233 without production changes. Base: fork main `50b6d9601` (verified origin `https://github.com/Edo771977/Atomic-Agent.git`; upstream `https://github.com/AtomicBot-ai/atomic-agent.git`). This is the C2a scope requested for #1570, irrespective of the older C-series numbering in the issue body.

## Candidate and provenance

The disposable candidate imports `31783844561946cab87294d441bcb8d856839f70` using `git cherry-pick -x`. Conflicts in session-state and normalization retain the fork's project reference, project normalization and replan counter as well as the upstream archive. A separate audit adaptation repairs the conflict join; its initial syntax failure is not counted as a safety finding.

`dc5a4b980ef152d467f71d23822d86254fffc466` does concern the new routes. Its isolated `cherry-pick -x` retains only their scope entries: GET read and POST admin, matching the fork's rollback permission. Upstream uses chat for both rollback and restore; accepting its entire table would also resurrect deferred routes and weaken fork decisions. Other entries are kept exactly as on fork main. Neither cherry-pick is included in this deferral branch.

## Reproduction and observed results

After `npm ci`, make a separate checkout from the stated base, apply those two commits with `-x` and the conflict resolutions above. Point `C2_CANDIDATE_ROOT` at that checkout, then run `node --import tsx --test docs/reviews/c2a-candidate.mjs` from this branch. It imports the actual candidate modules, including the real SQLite store and HTTP listener. It uses only synthetic data and temporary directories. It makes no model requests. Local HTTP connections must be permitted.

The [candidate output](c2a-candidate.log) records **14 assertions: 4 pass, 10 fail**:

- A single two-MiB answer is retained whole. Ten 256-KiB answers exceed two MiB despite the count cap. Unknown nested fields can retain the same large payload. There is no per-answer or session byte budget.
- Normalization accepts missing answer timestamps, object-valued reasoning, tool-bearing replies, infinite replacement timestamps and a steered prompt. These are separate executable assertions, not inferred failures from the count test.
- Saving a rolled-back incognito session writes `previousReplies` into the SQLite payload. The assertion reads the actual row through a separate read-only connection. Existing incognito transcript persistence is not changed or blamed on this import; the extra archived answer is the violation.
- A successful HTTP restore never acquires TurnController. Instrumentation observes its actual enqueue method, rather than mocking isBusy. This proves the missing lock acquisition; it is not a claim that every interleaving corrupts a chat. Rollback itself currently only checks busy status too, so safe integration requires a shared ownership seam for both mutations and turn execution, including stored owners in other processes.

The original upstream/fork truncate, previous-reply HTTP, rollback HTTP and scope suites also pass: 72 tests in four files. Passing audit controls establish admin restore/read listing scopes after the adaptation, named-admin private/unknown equivalence through the real dispatcher, removal with the chat, unchanged bytes of the preceding cloud journal after restoration, and exclusion of the archived alternative from Markdown export and the cloud conversation journal. This journal test is a narrower control than the required complete stable-prefix parity test across local and cloud prompt builders; full parity and memory formation remain reopening requirements.

The [absence regression](../../src/http/previous-replies-deferred.test.ts) was first run against the candidate and fails because the routes exist. The [red report](c2a-absence-red.json) preserves that result. On the deferral branch it checks the real listener for owner, admin, operator, member, viewer and anonymous requests, offline on/off, malformed input and ordinary/private/hidden/unknown ID labels. Neither session reads nor writes occur, and fixture bytes and directory entries remain unchanged. This is candidate-red/deferral-green evidence, not a claim that an enabled-feature test failed on main before implementation.

## Before reopening

Require one test for every guarantee below, observe each fail before its adaptation, and preserve the fork's current rollback refusal rules:

- Keep the prior answer, restore by HTTP, register the two explicit scopes in ROUTE_SCOPES and pin them in http-scopes.test.ts. Write access must match rollback/regeneration (currently admin).
- Private and withheld chats must be indistinguishable from unknown IDs for every named role, before parsing input or exposing history, using the #217/#220 dispatcher contract.
- Bound counts and UTF-8 bytes per answer, per question and per session, including reasoning and prompt data. Normalize malformed JSON shapes, non-finite numbers, unknown properties, oversized input and forbidden tool/steer/attachment flags. Do not restore a partially clipped answer as an exact original.
- Delete all archived variants with their chat; exclude them from all export formats, indexing, memory formation and both prompt projections. Test complete stable-prefix bytes before and after restore, permitting only the changed conversation to differ.
- Incognito retention must add no archive bytes on disk and must clean up any in-memory archive on close, delete, failed restore and shutdown.
- Acquire the same ownership primitive for rollback, regeneration, restore and turn execution; reject mutations during active or queued turns, recheck stored ownership under the lock, and test body-read/turn-start races and another process owning a turn.

No files in agent/step, policy, Fusion or subagents are changed. Only this entry's rows in the triage, the fork guide, affected README documentation, absence tests and review evidence belong to the PR.

## Verification

[Verification record](c2a-verification.json): npm ci, lint, imports:check, typecheck:tests and docs:check pass. The complete requested focused selection (eight workers, no exclusions) records **8,032 passed, 13 failed, 6 skipped**. All [seven new tests pass](c2a-new-tests.json). The [name comparison](c2a-comparison.json) reproduces 12 failing names on clean main; the remaining pre-existing login-absence subprocess test passes in paired main/C2a/C2b reruns. Its original failure is retained rather than erased. No additional failing name remains unresolved. The full npm-test comparison is recorded with the last PR, C2b, on the same base; this review does not claim an entirely green suite.
