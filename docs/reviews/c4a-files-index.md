# C4a: chosen-folder index and files.search

Status: current
Owner: docs/reviews/

Deferred under #233. No production code is imported. The dedicated fork checkout starts at origin/main `933e083818c3cc9d3cf8c2f1416324ff653baf11`; origin is `https://github.com/Edo771977/Atomic-Agent.git` and upstream is `https://github.com/AtomicBot-ai/atomic-agent.git`. C4b must remain deferred with C4a.

## Candidate and reproduction

Run [c4-prepare-candidate.ps1](c4-prepare-candidate.ps1) with an unused absolute `-Candidate` path and `-Through a`, then `npm ci` in that disposable checkout. Set `C4_CANDIDATE_ROOT` to it and run `node --import tsx --test docs/reviews/c4a-candidate.mjs` from this branch. The [audit](c4a-candidate.mjs) asserts the desired safe behavior, so its security failures deliberately produce a nonzero exit. All files, credentials and model clients are synthetic; listeners bind only to 127.0.0.1. No external model or host is contacted. Fixtures are deleted only under their freshly created temporary root.

The candidate has one `git cherry-pick -x` per upstream commit: `30404f00a`, `41d55a2da`, `e7b07c1e7`, `4eef35798`. The [review-only resolver](c4-resolve-candidate.ps1) retains fork session cleanup, cross-session scope, web egress, OS-tool return values, the memory documentation and project-tool grammar. The catalog count gains exactly one. These resolutions do not attempt to secure the new feature. They are absent from the deferral branch's production tree.

The [candidate log](c4a-candidate.log) records the assertions and outcomes. The original candidate tests and `http-scopes.test.ts` are summarized in [upstream tests](c4a-upstream-tests.json). Several original citation tests assume POSIX paths and fail on Windows; these are separate from the security findings below.

## Reproduced violations

- A chosen parent containing the protected state directory indexes a synthetic text file inside that state directory. `protectedDirs` rejects choosing the state directory itself, but does not filter descendants during the walk.
- A synthetic custom config path recognized by both `getStateSecretPaths` and `getTrustConfigPaths` is indexed. The index has no protected-input inventory admission interface. Hidden `.env` and extensionless `serve-api.key` happen to be skipped by extension/hidden-file rules; this does not establish protection for their aliases or other protected inputs.
- Both a detector-recognized vendor key and an opaque credential returned by the real `runtimeKnownSecrets` helper remain in SQLite chunk rows and reach the embedding-client seam unmasked. ToolRegistry masking happens after persistence and embedding. The audit opens the actual database to establish persistence; no real credentials are used.
- A query without `folder` passes the actual read-scope wrapper without an approval and returns another folder's text and citation. Only an explicit `folder` becomes a read target. Choosing a folder globally is not consent for every session or token to read it.
- Existing junctions are skipped, but replacing an already chosen root with a junction makes the next scan index text outside its original canonical root. Parent and unrelated absolute search folders are rejected. The successful controls do not establish protection against all mount, hardlink or in-walk substitution races.
- The walk accepts a file 70 levels down despite a requested depth bound. File count and individual size ceilings work. There is no depth or total-index-space setting in `FileIndexOptions`; adding more chosen folders and retaining old chunks also needs a global storage budget. Disk exhaustion was not attempted.
- `e7b07c1e7` retains old rows on unreadable/truncated scans, but a file-count-truncated completed scan reports no partial marker in search output. A done count alone is misleading. Existing upstream preservation tests exercise the retained-row behavior.
- `extractFileText` uses existing fork extractors, but invokes them without the dispatcher's 5 MiB `maxBytes` budget. It opens the file directly, bypassing input/read admission. This is a missing shared entry-point budget, not a claim that the strengthened Office, EPUB or MIME extractors were replaced.
- All four new routes lack `ROUTE_SCOPES` entries. The fork correctly falls back to owner-only for such missing entries; `http-scopes.test.ts` fails. With the intended read/admin scopes supplied only by the audit listener, a second named viewer can list the folder another named admin added. This is the leak enabling those scopes would introduce, not a named-token leak shipped on main.
- A real Node subprocess marked `ATOMIC_AGENT_TOOL_CHILD=1`, holding an inherited synthetic owner key, receives HTTP 200 and adds a folder. Server environment checks cannot establish who made the remote request, as in #235, #260 and C3b.
- Runtime locality uses `isLocalServerUrl`, which includes LAN and `.local` hosts. A synthetic embedding client selected for a LAN configuration receives document text without additional remote admission. This test observes the client seam, not off-machine wire traffic. The public-URL control disables embeddings correctly.

## Controls and limits

The audit also confirms chosen-only scanning, hidden `.env`/unsupported key skipping, existing junction skipping, parent/absolute search rejection, file count/size limits, registry untrusted framing/control-marker neutralization and turn taint, identical stable-prefix bytes before/after indexing for grammar/native transports, public embedding rejection, keyword fallback, and an array-only grammar retaining both files and project families. Framing is not proof that a model can never obey injected text: dispatch and approval still need enforcement.

No full grammar/profile/parser/transport conformance, page-citation authorization, index-space exhaustion, mount replacement, provider-policy/Privacy Shield integration or real remote embedding transport is certified by these controls. They remain reopening requirements. The [absence regression](../../src/http/files-index-deferred.test.ts) checks the actual descriptor/schema/routes and every HTTP role with inherited credentials in offline and online modes. It is candidate-red and deferral-green; [verification](c4a-verification.json) records counts and check outcomes.

## Before reopening

Add failing tests before adaptations for every contract in the C4 task: a person boundary an agent child or inherited key cannot forge; approved roots and per-token index ownership; canonical containment rechecked during scan/read/search; protected state/config/credential inventory and declared-input admission; file/count/depth/global byte ceilings; explicit partial/stale status; shared hardened document-reader budgets; secret masking before chunks and vectors using detector plus runtimeKnownSecrets; per-session hit filtering and path/page citations; untrusted result framing and taint; stable-prefix comparison across indexing; grammar/profile/parser/native transport agreement with an array root; read/admin route matrix and ownership tests. Bind embedding clients to actual effective endpoint, provider/host/egress/projects.constraints policy, fresh privacy request scopes and the process offline dispatcher. LAN is remote for this purpose. C4b needs its separate native-code trust and reranker checks after these pass.
