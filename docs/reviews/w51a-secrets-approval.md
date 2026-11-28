# W5.1a: credential shell decisions

Status: current
Owner: docs/reviews/

Base: fork main c9aaeedadad412242b00ed230da369ffb7223f81. Origin is Edo771977/Atomic-Agent; upstream is AtomicBot-ai/atomic-agent. This branch is independent of W5.1b.

The two source commits were imported separately with cherry-pick -x: 1bbccd17fb0486f4ea3d56a5b81b5665591a4e50 and ed7c265321541457e69bf09601d4f91f472f0eb1. The conflict preserves the fork CLI documentation: value get/set/unset commands and /api/secrets do not exist. The imported defensive value matcher does not introduce them.

## Review and adaptations

Upstream only asks below level 5. The fork requires an explicit one-shot decision for credential moves at every level, before any saved allow/session grant; a B1 deny still refuses before a prompt. The credential match precedes generic eval and nested-shell dangerous matches. Bounded inspection reads inline eval and known sh -c bodies only; it does not execute fixtures, read script files or resolve runtime variable values.

The fork origin guard already holds three computed ordinary cases that upstream marks ordinary: atag config get $KEY, atag config $S status and atag $A secrets status. Their tests preserve that stronger behavior. Plain config get/list, env, printenv PATH and xargs grep remain off the dangerous layer.

Shell classification is not OS isolation or proof of human provenance. #266 remains open. #260, #261 and #235 remain deferred; no credential store, HTTP secret-value API or direct OAuth sign-in is enabled. No chat-export/shared masker or agent-profiles files changed.

## Evidence

Tests preceded production changes. The initial RED had 77 failed assertions: 68 behavior regressions, three upstream ordinary expectations already inconsistent with the fork origin hold and six initial deny fixtures whose textual pattern omitted variable/option spellings. Those six fixtures were replaced by blanket-deny gate checks and a credential-specific POSIX deny comparison that conserves B1. Execution is mocked in the new shell integration fixtures, so no credential command is run. The final focused run has 334 passed assertions, including 13 credential-specific B1 conservation cases.

The B1 comparison is reproducible with node docs/reviews/w51a-personal-parity.mjs. It bundles the fixed main and the current personal parser and approval gate, compares structural results and actual saved-rule decisions without organization policy at levels 1/5. It reuses B1 option and input-routing fixtures. See [parity results](w51a-personal-parity.json). The comparison has 348 option analyses, 4,176 rule decisions and 303 structural POSIX/cmd/PowerShell comparisons, with zero changes. Bundles are temporary; fixture strings are never executed.

The [verification record](w51a-verification.json) records mandatory checks, absence tests and named comparison against the same main, including any failures. Unit checks do not attest every shell implementation or same-account process isolation.
