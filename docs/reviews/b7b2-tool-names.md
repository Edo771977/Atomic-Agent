# B7b2: tool-name resolution before policy

Status: current
Owner: docs/reviews/

Base: fork main `7511497b0`. Origin: `https://github.com/Edo771977/Atomic-Agent.git`; upstream: `https://github.com/AtomicBot-ai/atomic-agent.git`. Related issues: #233 and B1 limitations #266.

## Provenance and changes

Imported with separate `git cherry-pick -x` commits: `533195f1e1e4050671d6a845e99bd63b8d2a4951` and `a7129ad7f2c3e6f57aaf8c73ba638736fd05aef2`. The README conflict keeps the fork's existing credential vocabulary, B7a3 closed reporting tags, offline/opt-in/incognito description and appends the new near-miss reporting rule. No external reporting gate is removed.

The second commit resolves registered names at the first parsed-batch policy boundary, before progress splitting, fabricated-transcript/claim/link checks and approval trim. Unknown spellings remain unknown and receive their ordinary refusal. Dispatch still uses the canonical identity for B1, turn filters and the registry's read/input/approval protections.

The fork adaptation removes the resolver's earlier separator/case shortcuts: those could return the first matching tool without considering a second colliding spelling. Every nonexact form now compares against the complete catalog; two matches always return null, in either registration order. Exact registered identities remain exact. Two bounded cleanup passes handle both a quoted empty call and an empty call inside quotes, without accepting arguments or guessing a missing letter.

## Before-code and adaptation tests

The initial eight [policy-boundary tests](../../src/agent/tool-name-policy-boundary.test.ts) ran before the imports: two passed and six failed. With both upstream commits, six passed and two still failed: ambiguous fast paths and the quoted-call spelling. After the adaptation, 76 tests in the six focused resolver/lifecycle/filter/reporting/trace suites passed. [Recorded evidence](b7b2-red-green.json).

The expanded boundary suite adds actual dispatch controls and is part of the required area selection:

| Requirement | Evidence |
| --- | --- |
| Resolved name cannot bypass B1 | Canonical, functions-prefixed and quoted/case/separator spellings all receive the same edit-deny result before invocation. |
| Approval level is unchanged | The actual ApprovalGate refuses each spelling at level 1 and lets each run at level 5, with the same prompt counts. No resolver grants approval. |
| Tool filter survives trim | At both levels, an excluded wrapped write cannot displace an allowed read. The existing agent-loop-tool-filter suite also covers native, text, reasoning and grammar recovery. |
| Ambiguity | Three colliding spellings are refused in both catalog orders; exact names remain exact. |
| MCP capture | A registered `mcp.untrusted.os.shel` cannot resolve `os.shel` or its missing-namespace form. Short MCP names and letter typos are refused; only full-name separator/case/wrapper changes are eligible. |
| Read scope | A wrapped read outside the worker's scope is refused by the actual read-confinement adapter before its runner. |
| Input files | A wrapped write with overwrite=true cannot replace an actual synthetic declared input, even at level 5; no prompt is raised. |
| Cancellation | Aborting after the completion but before dispatch prevents the resolved runner. |
| Stable prefix | Processing the alias changes neither the prepared prompt nor catalog identity/order. No prompt/grammar descriptor source changes. |

These fixtures do not execute commands, contact MCP servers or use personal files. The input replacement test uses one disposable file. The policy tests concern name resolution and dispatch; they do not broaden B1's shell classifier guarantees or resolve the open limits in #266.

Only `near_miss` unknown-tool streaks are suppressed in external error reporting. `mcp_like` and other streaks still report through the fork's opt-in, offline and incognito gates; local trace/warn records remain. The existing upstream reporting and runtime trace tests cover those cases without adding emitted names to report tags.

No session-export, HTTP-export, subagent, profile or shared worker-runner files change.

## Verification

`npm ci`, `npm run lint`, `npm run imports:check`, `npm run typecheck:tests` and `npm run docs:check` pass. The final expanded dispatch-boundary suite passes **14 tests**; the six resolver/lifecycle/filter/reporting/trace suites pass **76 tests**. No timeout, skip or quarantine was added.

The required broad command was executed in full:

```text
npx vitest run src/agent src/policy src/tools src/mcp src/llm src/local-llm src/tui src/http src/runtime
```

It is **not green**: **24,080 passed, 1,020 failed, 575 skipped**, with no suite-load errors. The clean pinned-main complete run is **33,928 passed, 1,060 failed, 667 skipped**. The [file/name comparison](b7b2-focused-comparison.json) lists all 953 common failures, 67 additional failures and main-only differences for the selected files. Only checkout roots and slash direction are normalized. Windows restrictions and timing affect subprocess/Git, symlink and local-network fixtures; this does not automatically explain every failure.

The [paired named controls](b7b2-focused-controls.json) rerun every additional assertion with one worker on both main and the candidate. The [verification record](b7b2-verification.json) summarizes those outcomes and retains raw report hashes. An isolated retry passing does not change the recorded broad-run failure. The complete `npm test` comparison for the series is also recorded in B7b3. The source base remains `7511497b0`; later main `5da6478ff` has only unrelated documentation/absence-test changes and the virtual merge was clean.

Names still failing only on the candidate in that first paired control receive one [further sequential paired diagnostic](b7b2-diagnostic-controls.json), with complete default-reporter logs for [main](b7b2-diagnostic-main.log) and [the candidate](b7b2-diagnostic-b7b2.log). Original results remain above; the verification summary uses the latest result for each name.

Final named follow-up: **65 of the 67 additional assertions pass on the candidate; two fail on both main and the candidate**. All three discordant names in the first paired control pass on both checkouts in the diagnostic. No candidate-only failure remains in this isolated comparison; the original broad run remains failed.
