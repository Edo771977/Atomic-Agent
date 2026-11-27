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

The verification record and failure-name comparisons are attached after the required checks finish.
