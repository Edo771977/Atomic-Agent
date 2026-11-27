# C4b: optional sqlite-vec and reranker

Status: current
Owner: docs/reviews/

Deferred under #233 after [C4a](c4a-files-index.md), which is a required predecessor. No production code, dependency or supported environment variable is imported. The PR is stacked on the C4a deferral; CI runs only on PRs targeting main.

## Candidate and reproduction

Run [c4-prepare-candidate.ps1](c4-prepare-candidate.ps1) with an unused absolute `-Candidate` path and `-Through b`, then `npm ci` in it. This reproduces all four C4a picks and `git cherry-pick -x 2dda8366f`. The last pick conflicts with 41d55a2da in search/vector scanning: the script keeps that commit's closest-vector scan and passes the query to it when sqlite-vec cannot help. It retains the mirror, by-ID reads and rerank integration. The reconstructed tree was compared with the audited candidate. These are review-only conflict resolutions.

Set `C4_CANDIDATE_ROOT` to that checkout. From this branch run `node --import tsx --test docs/reviews/c4b-candidate.mjs`. The [audit](c4b-candidate.mjs) asserts safe behavior: [output](c4b-candidate.log) is **13 tests, 9 pass, 4 fail, no skips**. The [original candidate suites](c4b-upstream-tests.json) include extension and reranker tests plus HTTP scope coverage. Windows-specific failures in original path/citation fixtures are listed separately from this audit's findings.

All credentials and documents are synthetic. The native-loader proof creates a previously absent sqlite-vec JavaScript package only in the disposable candidate's node_modules, records a harmless execution marker and intercepts loadExtension with a fake database. It never compiles or loads native code. It refuses to overwrite an existing package and removes only the package it created. Model/network fixtures bind to 127.0.0.1; nonlocal offline requests are intercepted before DNS or connection. No external model is called.

## Observed failures

- The loader imports a bare sqlite-vec specifier and executes its JavaScript without a pinned location or provenance check. An agent-writable package under the candidate's node_modules sets the marker and asks the fake database to load a library from the same writable tree; loadSqliteVec reports success. Failure handling after import cannot undo code already executed. The test demonstrates module execution and a native-load request, not execution of an actual malicious native library.
- Reranker configuration treats RFC1918, .local and Tailscale addresses as local. No remote admission is requested. A LAN endpoint is not this computer, even when the model server classifier calls it local.
- A real loopback rerank request is sent under a deny-all provider/host/egress frame. createHttpReranker uses fetch directly rather than the guarded provider path, so projects.constraints are not applied.
- Synthetic detected and runtime-known credentials reach a simulated remote reranker request body unmasked. This tests the direct HTTP seam with intercepted fetch; it does not claim actual external transmission. No Privacy Shield archive is established by this path; full privacy/consent integration remains a reopening condition.

## Controls and scope

Missing sqlite-vec, a loader returning false, a loader throwing and explicit vectorExtension:false all retain keyword and semantic fallback. A failed reranker keeps the original order. Reranking is off by default and a public endpoint is refused by rerankerFromEnv.

The actual fork process offline dispatcher blocks a nonlocal reranker before connection; its blocked counter increases and requestsOut does not. A loopback reranker still works offline, and its HTTP 307 redirect to a nonlocal host is blocked. Therefore this review does not claim that the global offline transport is bypassed. Provider/egress/privacy checks are a separate missing layer.

The entire five-commit candidate changes neither package.json nor package-lock.json, so no new install script is introduced. No real sqlite-vec binary is installed in this audit. Native ABI behavior and a trusted packaged extension need separate supported-platform tests before import.

2dda8366f changes file search only; it consumes memory's embedding client and weights but adds no sqlite-vec/reranker integration to memory retrieval. The requested memory behavior cannot be claimed from this commit. It must be designed and tested against scoped/disabled memory and its existing fallback after C4a and extension trust are resolved.

The [absence tests](../../src/tools/files-vector-rerank-deferred.test.ts) fail on the candidate and pass on the deferral. [Verification](c4b-verification.json) records setup, static checks, the six-area selection and the complete-suite name comparison against clean main. The protected parallel-work paths remain unchanged.

Setup, lint, imports, test typecheck and docs checks pass. The complete suite (`npm test -- --maxWorkers=6`, no quarantine) records 30,920 passes, 111 failures and 660 skips; clean main records 30,907 passes, 115 failures and 660 skips. The [complete comparison](c4b-full-comparison.json) has no additional failed name or suite-load error. All nine C4a/C4b tests pass in that run. The [six-area selection](c4b-focused-comparison.json) records 12,102 passes, 43 failures and 546 skips. Its four additional timeout names pass in both complete runs, with their original deadlines; their individual statuses and durations are retained in verification. The four main-only failures are not claimed as fixes. Production and test sources are unchanged after these runs; the stack rebase carries C4a evidence only.

## Before reopening

First satisfy C4a. Resolve extension provenance before importing any package JavaScript or loading a native library: use a person/package-pinned absolute location with protected ancestors and content, reject working-directory/environment/agent-writable substitution, and preserve silent fallback for missing/load failures. Avoid install-script additions; audit any changed dependency as in B5. Test trusted success and rejected substitutions on supported platforms with actual binaries.

Keep reranking optional and on this computer by default. Any off-machine endpoint, including LAN or redirected loopback, needs the normal configured-provider, allowedProviderHosts, allowedEgress, projects.constraints, credential, consent and Privacy Shield lifecycle. Preserve the proven global offline dispatcher, local allowance and fallback through failure/cancellation. Apply the same boundaries to memory if that separate integration is added, with scope and disabled-entry tests and no cross-session secret archive reuse.
