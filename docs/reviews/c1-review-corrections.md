# C1 PR review corrections

Status: current
Owner: src/agent-profiles/

Historical first-review evidence. Point 2's lower-priority fallback was unsafe and is superseded by the [second review](c1-review2-corrections.md): rejected tool selections again reserve their names, with visible source/tool warnings. The optional built-in pruning, real-catalog prefix test and depth documentation remain in force.

PR #298 merges origin/main 54f81900b9220268e6f88a8276d00feb4769f603 in 247566f3ba5dee02b00c43b5f9af76e292ab734f before publishing these corrections. The two README conflicts retain both C1 and B7 notes; no runner implementation is replaced. Each review point has its own commit.

| Point | Commit | Failure before change and verification |
| --- | --- | --- |
| 1. Optional built-in tools | a8a43638531a036124eaf41d073c1b5d474257bb | builtin-catalog.test.ts: `C1 review 1: research survives a disabled browser and its worker cannot use browser tools` and `C1 review 1: missing all optional tools never turns a builtin into an unrestricted worker` fail before the loader change. Afterwards all four catalog cases and the settings/task-profile selection pass (23 tests). |
| 2. Valid fallback after rejection | e0e5c7d4e4ce4b4544d4a0bd97064988647b9d42 | settings-import.test.ts: `C1 review 2: rejects invalid person profiles and retains the valid builtin fallback` fails while rejectedNames reserves the name. It then passes for mixed known/unknown names, forbidden memory and delegation, forbidden wildcard selection and malformed spelling. Custom invalid profiles remain absent; the 23-test selection passes. |
| 3. Non-vacuous prefix check | 8a53c92009091de661aa3c97fae543088a82b0b2 | The existing `C1d: rereads config bytes without moving an open session's stable prefix` test fails when required to contain the applied `PROFILE auditor (settings)` block. The replacement uses DEFAULT_TOOL_DESCRIPTORS filtered by the real worker policy, loads a settings profile, applies it through applyTaskProfiles and renders the actual worker brief. Both local/cloud sessions retain prefix bytes across instruction reloads; removing a real descriptor changes those bytes. All three settings tests pass. |
| 4. Present and future depth | f7dd536c4c4f5bc759836af314ae4ba0ab617ce9 | Documentation only: no fabricated failing code test. The profile README states the present FUSION_WORKER_DEFAULT_DEPTH stamp and requires childFusionWorkerDepth(parent.metadata) for C1e child creation. Existing depth/session coverage passes (15 tests). |

Built-in pruning never converts a wholly absent selection to an unrestricted profile: reply remains an explicit allowlist entry, and workerToolFilterFor still applies the worker ceiling. Explicitly forbidden exact names are rejected even if absent from the catalog. Person-authored selections retain strict unknown/malformed/forbidden validation. Rejected candidates contribute no prompt, model or tools to a later valid copy.

The [before/after record](c1-review-before-after.json) preserves actual failing names and result counts. The initial C1 reports remain historical evidence of their pinned source; this correction supersedes their rejected-name behavior and their earlier empty-catalog prefix test. C1e remains unreachable and deferred.

## Final verification

Lint, imports:check, typecheck:tests and docs:check pass. The final type ledger has 667 existing diagnostics and no new allowance. The requested command runs unchanged, including src/agent-profiles, with no exclusions or longer timeout: 20,189 passed, 17 failed and 546 skipped across 1,290 files. It exits 1 and is not described as green. An earlier attempt stopped without a final report; only the completed retry supplies these totals.

The [platform comparison](c1-review-platform-comparison.json) matches fifteen failures by relative file and full assertion name against fresh main 54f81900b9: 142 passed, fifteen failed, 85 skipped in the six relevant files. The other two failures are candidate-integration fixture cases. Both exact names pass on main and the corrected branch in a one-worker rerun, with unchanged timeouts. The [selection](c1-review-fusion-selection.json) and [paired result](c1-review-fusion-comparison.json) retain that evidence. No additional profile failure is left unresolved. The full requested run also passes all four builtin-catalog cases, all three settings-import cases, the sixteen task-profile cases and the three C1e absence cases.

Before publication, main advances to d60d715468dcf2f2cb7ce7bd0e231b26d62ae261 (Core install/idle). It is merged in 62e1eb7e585f18046815034216b82d3f0c1aabfd. Git confirms no file under any of the requested test directories changes between f7dd536c4c4f5bc759836af314ae4ba0ab617ce9 and that final merge. The incoming Core tests, runtime catalog, corrected profiles and C1e absence checks are then rerun: 95 passed, zero failed. Lint, imports and test types are repeated successfully after the merge.

The [verification record](c1-review-verification.json) identifies both main merges, the source tested by the full selection, the interrupted attempt, the completed reports and per-name rerun results. These Windows failures are preserved in the evidence rather than hidden as a passing suite.
