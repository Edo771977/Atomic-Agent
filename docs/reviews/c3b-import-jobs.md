# C3b: background facts import and HTTP routes

Status: current
Owner: docs/reviews/

Deferred under #233 after [C3a](c3a-user-facts.md). No production code or route is imported. Base main and remotes are recorded in C3a; the PR starts from the C3a deferral branch. C3c/C3d must remain deferred too.

## Candidate and reproduction

Use [c3-prepare-candidate.ps1](c3-prepare-candidate.ps1) with `-Through b`, then `npm ci` in the disposable candidate. The chain uses one `git cherry-pick -x` for each of d093ba6a4, 374fc05f5, 6edc49563 and a45ab2986. The capability conflict retains the fork's project and Fusion-team fields and adds the candidate import capability beside them. This is a review-only conflict resolution. The fork is not otherwise adapted.

Set C3_CANDIDATE_ROOT to that checkout and run `node --import tsx --test docs/reviews/c3b-candidate.mjs` from this branch. The [audit](c3b-candidate.mjs) loads the actual reader, service, jobs, SQLite stores, scope guard, privacy archive and HTTP handlers. All fixtures are synthetic and temporary; servers listen only on 127.0.0.1. No remote provider is contacted. Only disposable mkdtemp trees are removed.

The [candidate output](c3b-candidate.log) records 28 tests: **4 pass, 22 fail, 2 skip**. Two folder/file-symlink tests skip because Windows denies file symlink creation. They must be rerun on a capable host; no folder containment guarantee is claimed.

## Observed failures

- Both ChatGPT and Claude accept ZIP entries with parent traversal, absolute paths and Unix symlink metadata. JSZip sanitizing a name is not rejection of the original unsafe path. These are readers, so this is acceptance of unsafe archives, not a claim that they extracted files onto the filesystem.
- Both accept a compressed conversations.json larger than the fork's 10 MiB per-entry limit and an archive above 10,000 entries. An archive whose declared inflated content exceeds 100 MiB also passes. Separate tests accept a large unpacked JSON file and 3,000 nested arrays. These fixtures exceed the existing archive defaults without relying on dangerous memory exhaustion.
- A synthetic ZIP at serve-api.key is read despite being recognized by the real fork protected-input inventory. No actual credential file is read. The new reader has no read-scope/input-protection admission interface; its route accepts any absolute path. An upload-only or approved-root design is required before enabling it.
- With actual validated config memory.profile.enabled=false and memory.notes.enabled=false, the service still writes a profile fact. A second test extracts inside a provider-policy frame, then saves as a later request: the resulting fact is globally visible because the job did not retain the constraint scope.
- All seven routes are missing from ROUTE_SCOPES. The existing http-scopes.test.ts also fails on the candidate. Commit dc5a4b980 was examined: it assigns read to job/receipt reads and admin to start/stop/save/forget/undo. The HTTP audit supplies exactly those seven explicit scopes in its test listener; it does not cherry-pick unrelated routes from that broad merge fix.
- With those intended scopes, a named viewer reads an admin token's job, including candidates. The current missing-scope fallback is owner-only, so this is the leak that enabling the intended read scope would introduce, not a named-token leak already shipped by the fork.
- An actual Node subprocess marked ATOMIC_AGENT_TOOL_CHILD and holding an inherited owner key receives HTTP 200 and saves a fact. The expected person boundary is 403 and zero saved rows. Scope classification alone cannot establish who approved.
- Stop propagates AbortSignal, but an in-flight completion that ignores it leaves settled() pending. The test releases the synthetic completion in finally; no lingering job or remote request is created. Cancellation of synchronous reads/decompression also needs a bounded or isolated design.
- Two separately bound cloud runs reach the real Privacy Shield boundary with the same archive object because every run uses the fixed import-facts partition without a fresh request archive. This establishes archive lifetime reuse, not plaintext-on-wire exfiltration. The fixed partition must not be reused as private request identity.

## Controls and limits of evidence

6edc49563 correctly treats explicit LAN, .local and remote llama.cpp URLs as cloud, and literal loopback as local. The fixed model binder uses the supplied guarded provider: an active constraints configuration without a policy frame refuses before the completion seam, with no fallback call. The existing offline guard refuses nonlocal hosts and permits loopback. Therefore this audit does **not** claim the direct binder bypasses the registry or process-wide offline transport as the separate endpoint in #283 did. End-to-end tests with actual configured providers, redirects and effective managed-server URLs remain required.

The fourth passing control verifies that unapproved candidates are absent from the fixture's state files, then saves and undoes an import while preserving an unrelated profile fact. It does not prove all diagnostic/report sinks or receipt-tampering protections. The original candidate suites record 80 passes and one failed assertion in http-scopes.test.ts; [summary](c3b-upstream-tests.json).

## Before reopening

First repair C3a, then add failing tests before each adaptation:

- Share the fork archive admission limits and original-path checks, including absolute/parent paths and symlinks, actual inflated bytes, total size, entry count, raw JSON bytes/depth and cancellation. Exercise both sources with adversarial archives and canonical folder containment.
- Admit input through an operator-approved upload or approved read roots; enforce state/input protection and read scope before opening files. Retain read taint and project constraintKey across every background request, including save and undo.
- Bind approvals to exact job/candidates and a person operation that an agent child or inherited bearer cannot forge. Keep candidates/quotes in process memory, with count and length caps, secret masking using runtimeKnownSecrets, and count-only diagnostics through failure/cancel/expiry.
- Refuse saves when memory is disabled; retain disabled row state. Bind receipts to exact created rows/import ownership and preserve unrelated facts and later edits, including after restart. Protect receipt storage against agent rewriting and symlink substitution.
- Use one fixed configured model; no cloud fallback. Default to the actual effective endpoint on this computer. Explicit LAN and remote llama.cpp require fresh per-run consent, including when reached through localModels.url rather than a provider URL.
- Keep the guarded provider and all provider/host/egress/projects.constraints checks. Use a fresh Privacy Shield archive for each run, including retries, failures and parallel work. Test offline with actual nonlocal transport intercepted at the wire, not just a mock provider.
- Put all seven routes and scopes in ROUTE_SCOPES and http-scopes.test.ts. Test owner and all named roles, token-specific ownership for status/candidates/receipts/stop/save/undo/forget, bounded admission and real cancellation. An unguessable job ID is not an ownership check.

The [absence regression](../../src/http/import-facts-deferred.test.ts) is candidate-red and deferral-green ([red report](c3b-absence-red.json)). Required setup/static/focused checks and any main comparison are recorded in [verification](c3b-verification.json). Protected parallel-work paths are unchanged.

Final setup, lint, imports:check, typecheck:tests and docs:check pass. The complete requested six-area selection records 12,388 passes, one failure and 12 skips; all eight new absence tests pass. Its only failed name is the same VoteStore timing case reproduced on main. The [name comparison](c3b-focused-comparison.json) matches focused failures against the complete clean-main run; baseline-only names include areas outside this selection and are not claimed as fixes. The initial documentation check ran before its linked upstream-suite summary was copied; after adding that evidence, the final check passes. The final C3d PR supplies the complete-suite comparison.
