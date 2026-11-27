# B7a1 memory housekeeping history

Status: current
Owner: docs/reviews/

Deferred. No upstream commit or production code is imported. Reviewed `1570a8140c53f2d987ca813dd1fa9a8542ab6ccc` and `5fa2a2dec6a0f49bedc01c29b50826619fca0632` against fork main `904476e2e099903833223beb4a0ace08b8d7a220`.

Reproduction requires `npm ci` and the upstream objects: fetch `upstream main` from `https://github.com/AtomicBot-ai/atomic-agent.git` if they are not available locally.

The executable [candidate audit](b7a1-candidate.mjs) evaluates the complete upstream restore owner with synthetic stores, before any production edit. Run `node --test docs/reviews/b7a1-candidate.mjs`: three assertion failures show that a split merge loses the absorbed note's constraint scope and disabled state, and accepts writes with memory disabled. The fork calls the persisted field `constraintScope`; its descriptor contains the constraint key. The dependency flag in the disabled test deliberately demonstrates the absence of any enabled-state contract; this is a unit audit, not an HTTP integration claim.

The upstream lesson/procedure snapshots likewise carry no constraint descriptor. New reactivation operations bypass the fork's disabled-entry semantics. The second commit only changes an invalid query fixture from lesson to an unknown kind; it fixes none of these boundaries. The HTTP handler wires both stores into an existing admin route but adds no independent proof that its caller is the person. An inherited owner credential remains the same trust problem documented for #235 and B4a; a process environment check in the server cannot identify a remote caller. Expanding resurrection before a non-grantable operator decision is established is outside a narrow safe import.

The separate [operator-boundary audit](b7a1-operator-boundary.mjs), run with `node --import tsx --test docs/reviews/b7a1-operator-boundary.mjs`, exercises the existing fork handler and real stores in a temporary SQLite database. A Node child with `ATOMIC_AGENT_TOOL_CHILD=1` and an inherited synthetic owner key posts to the real HTTP listener's admin restore route. It receives **200** and restores the note deleted with actor `user`, instead of the required 403 with the note still absent. This is a pre-existing boundary failure on the verified base, before any housekeeping import; the production-free deferral does not repair it. It establishes why adding further resurrection operations requires an independent operator decision first.

The passing regression `src/http/memory-housekeeping-deferred.test.ts` pins absent lesson/procedure history and absent unarchive/split methods, while retaining read/admin scopes for existing routes. This does not claim that existing note/profile restoration is repaired.

Before reopening, write failing integration tests for every new operation: preserve the absorbed row's original constraint descriptor and disabled state; refuse foreign folders; make memory-disabled operations inert; never journal or restore incognito material; preserve explicit route scopes; and refuse agent restoration of person-deleted entries even with an inherited owner key. Cover create/deprecate, merge, archive and eviction separately, including stale legacy snapshots. The enabled feature remains deferred until all pass.

Verification reruns use canonical Git LF bytes: the initial Windows checkout conversion caused archive/type diagnostics and two byte-sensitive grammar failures. All static/documentation checks pass after restoring the original bytes. A paired rerun of grammar, voting and session-worktree tests gives 77 passed / 2 failed on both main and this branch: the same cleanup and duration cases fail. Both grammar cases and the other cleanup case pass on both. These results do not claim a green complete suite.

## Verification results

The [verification record](b7a1-verification.json) preserves upstream provenance, red/green controls and initial attempts plus final retries. All final setup/static/documentation checks pass. The [name-by-name comparison](b7a1-comparison.json) uses the same main baseline and preserves every initial failure.

Requested focused suite: **12975 passed, 28 failed, 38 skipped**. 24 initial failures match main's complete run by file and full test name; 4 additional names are accounted for by the recorded controlled reruns. No additional failure remains unresolved. Every new test passes.

Main's complete run: **30572 passed, 157 failed, 658 skipped**. A failed baseline test that passes here is recorded without attributing a fix to this feature. These reports do not claim an entirely green suite.

The two initial grammar failures pass after canonical LF restoration on both checkouts. The wider paired run reproduces cleanup/duration failures on both; a later selected cleanup run passes both cases on main and B7a2. The reports preserve these differing observations.
