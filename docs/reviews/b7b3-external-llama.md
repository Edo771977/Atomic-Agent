# B7b3: external llama.cpp probe deferred

Status: current
Owner: docs/reviews/

Base: fork main `7511497b0`. Origin: `https://github.com/Edo771977/Atomic-Agent.git`; upstream: `https://github.com/AtomicBot-ai/atomic-agent.git`. Related issues: #233 and B1 limitations #266.

## Decision and reproducible candidate

Deferred as one group: #1562 (`f0c5d5da2e81224ac5c0d746125b94396e77c7a2`), #1563 (`4ac920e76a8c4388e90b7984cd169d1849064c24`) and `fix/ato-1559-turn-model-wire` (`81cd5a04099ac60aa78ef93c714dbc721f4d9931`). No production source enters this PR. The new absence regression is deliberately green on the deferral and red on the candidate.

The [candidate mail patch](b7b3-candidate.patch) preserves a separate `git cherry-pick -x` for each upstream commit and a final assembly adaptation (`8af0c8a0b`). Apply it with `git am` in a disposable checkout from the base above, then `npm ci`. Run:

```text
node docs/reviews/b7b3-candidate.mjs /absolute/path/to/candidate /absolute/path/to/report.json
```

The script temporarily installs its adjacent fixture under the candidate's runtime-composition test directory, refuses to replace an existing file, runs the actual candidate code and removes only its own test file. It captures the real runtime's servedModelOf callback while replacing the Fusion builder with an inert capture tool. No worker, subagent, browser or external server is started. Fetch is replaced before the actual LlamaServerClient is constructed. All hosts, config, policy and keys are synthetic; Vitest's isolated state setup is retained.

Conflict choices keep the fork's workerPinModel, team routing, project checks, budget/receipt assembly and existing tests. The candidate callback is transplanted into the equivalent runtime catalog location with its original direct-client behavior. The 81cd5a040 context requires the small foreign-llama helper and localServerUrl option from its upstream parent, included as explicit candidate-only prerequisite adaptation. That classification change is not imported into the fork. The final candidate lint passes. The patch contains the evaluated candidate, not an assertion that all upstream branch ancestry is imported.

## Observed results

[Candidate assertions](b7b3-candidate-results.json): **2 pass, 9 fail**. They show attempts at the fetch seam before admission, not successful real egress through the process-wide offline dispatcher.

| Boundary | Observed candidate result |
| --- | --- |
| Provider allowlist | A frame allowing only local-llama still reaches fetch for worker-review. |
| Egress/project constraints | An allowed provider with no allowed egress class still reaches fetch. A LAN endpoint with no allowedProviderHosts also reaches it. |
| B1 deny | An organization web deny on the synthetic host is not checked by the callback before fetch. |
| Offline | The callback invokes fetch while offline. Real transport's own offline backstop is separate and does not satisfy the required preflight. |
| Key origin control | Positive control: the initial /props request uses the configured origin and synthetic bearer key. |
| Redirect | RequestInit.redirect is absent, so fetch retains its automatic redirect default. This audit does not claim that Node forwards its standard Authorization header across origins; the required no-cross-host-redirect policy is nevertheless missing. |
| Response bound | A simulated one-billion-byte Content-Length reaches response.json(); there is no pre-JSON byte admission. |
| Timeout | Positive control: the existing probe timeout aborts a signal-aware transport. This does not prove a deadline against arbitrary code that ignores AbortSignal. |
| Untrusted label | A 10,013-character alias containing terminal controls is returned unchanged by the label helper; the combined bounds/sanitization assertion fails on length. The label also feeds worker-leg model attribution in the candidate. |
| Remote local-llama | An entry pointing to a remote host is labelled with this computer's managed model when its id is local-llama. This is an attribution failure; this test alone does not prove an inference-permission bypass. |

The existing served-label, TUI and resolver suites pass **37 tests** while the four new [absence assertions](../../src/runtime/composition/external-llama-deferred.test.ts) fail on the candidate. On the deferral branch all four absence assertions pass: no servedModelOf callback is wired for remote, LAN or alternate loopback entries, and the new served-label module is absent. Existing routing and guards are preserved byte-for-byte.

## Before reopening

- Apply provider id/actual endpoint, host, project egress/read-taint, B1 and offline admission before every probe. Cover missing frames and changed policy as well as allowed frames.
- Keep a key bound to its configured origin. Reject userinfo and cross-host redirects before another request. Bound request lifetime and bytes while streaming, before JSON decoding.
- Use a bounded control-free label, visibly attributed to an untrusted server report. Do not use it to select providers, grant permissions, or replace an authenticated/configured model identity in routing, receipts or pricing evidence.
- Treat only this computer as local. LAN and remote llama.cpp are cloud for this feature. A local-llama id never overrides actual endpoint provenance or cloud checks. Retain the fork's classification if upstream's id exception conflicts.
- Disable all external-server model choices in the TUI and in the command path, including a remotely configured local-llama. Keep #1563 together with the preceding admission/classification work.
- Add a failing test for every point before implementation, including cancellation and redirect/response limits.

The candidate touches `src/tools/fusion/fusion-delegate.ts` and runtime catalog assembly, shared Fusion/C1 integration seams. The deferral changes no runner source, subagent.run, agent profiles, session export or HTTP export files. Fixing and enabling this candidate during concurrent runner work would require a coordinated routing/provenance change; the narrow PR records the blockers instead.

## Verification

`npm ci`, `npm run lint`, `npm run imports:check`, final `npm run typecheck:tests` and `npm run docs:check` pass. The first test typecheck caught an incorrect provider-type import in the new absence test; that import was corrected before the final successful check. The four final absence assertions pass. No timeout, skip or quarantine was added.

The required broad command was executed in full:

```text
npx vitest run src/agent src/policy src/tools src/mcp src/llm src/local-llm src/tui src/http src/runtime
```

It is **not green**: **24,052 passed, 1,018 failed, 575 skipped**, with no suite-load errors. The [file/name comparison](b7b3-focused-comparison.json) lists 949 common failures, 69 additional failures and main-only differences for the selected files. Only checkout roots and slash direction are normalized.

The required complete `npm test` was executed without exclusions on both pinned main and this branch:

| Checkout | Passed | Failed | Skipped | Files |
| --- | ---: | ---: | ---: | ---: |
| Main `7511497b0` | 33,928 | 1,060 | 667 | 2,647 |
| B7b3 | 33,882 | 1,110 | 667 | 2,648 |

Both exit 1; neither has a suite-load error. The [complete name comparison](b7b3-full-comparison.json) records **1,042 common, 68 additional and 18 main-only failures**. Windows restrictions and timing affect subprocess/Git, symlink and local-network fixtures; this does not automatically explain every failure. Production source is identical to the pinned base.

The [focused paired controls](b7b3-focused-controls.json) rerun all 69 additional focused names with one worker on both checkouts. The [full-only paired controls](b7b3-full-extra-controls.json) cover the other 14 names that appear only in the full run's additional set; the 54 overlapping names reuse the focused controls. The [verification record](b7b3-verification.json) records every paired outcome and hashes of the raw complete reports. An isolated retry passing does not change the original broad/full results. The source base remains `7511497b0`; later main `5da6478ff` has only unrelated documentation/absence-test changes and the virtual merge was clean.

The one name still failing only on the candidate in the first paired control receives one [further sequential paired diagnostic](b7b3-diagnostic-controls.json), with complete default-reporter logs for [main](b7b3-diagnostic-main.log) and [the candidate](b7b3-diagnostic-b7b3.log). Original results remain above; the verification summary uses the latest result for each name.

Final named follow-up: **68 of the 69 additional focused assertions pass on the candidate; one fails on both checkouts**. For the full run's 68 additional names, **67 pass on the candidate and one fails on both**. The one discordant focused name passes on both checkouts in the diagnostic, and all 14 full-only names pass on both checkouts. No candidate-only failure remains in these isolated comparisons; the original broad/full runs remain failed.
