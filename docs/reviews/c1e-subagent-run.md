# C1e: subagent.run deferred

Status: current
Owner: docs/reviews/

C1a-C1d are imported separately. C1e (#1733), including the later spend-ceiling chain and test corrections, is deferred under #233. No C1e production code, tool registration, hook alias, grammar verb or per-turn write grant enters this branch.

## Candidate and reproduction

The [preparation script](c1e-prepare-candidate.ps1) creates a fresh review checkout at upstream parent `3ee5204d9720d3ec3a330eed6455d4dd65aaa694`. That parent contains C1a and the first two C1b commits. The script applies the six remaining C1b/C1c/C1d prerequisites, then all fifteen specified C1e commits individually with `cherry-pick -x`, through `2794bdf005a2708db87a6b0e864e2ac631b20294`. This is an intrinsic upstream audit, not a claim that upstream replaces the fork's runner or dispatch. The production integration branch starts at fork `origin/main` `7511497b02504f81ffa03ec8f63367119fdaa6d8` and retains its guards.

The only replay conflict is the C1d/C1e profile README paragraph: the [checked resolver](c1e-resolve-candidate.mjs) keeps settings reload documentation and replaces the obsolete Fusion-only sentence. It refuses any other conflict; no production implementation is overwritten to prepare the audit.

From this branch, set `C1E_CANDIDATE_ROOT` to that checkout and run:

```powershell
node --import tsx --test docs/reviews/c1e-candidate.mjs
```

The [audit](c1e-candidate.mjs) imports the candidate's actual tool, shared runner and ledger. It creates disposable synthetic state, supplies deterministic usage at the completion seam and never calls a provider or executes a shell command. The [result](c1e-candidate.log) contains two failed safety assertions and three passing controls:

- A cloud worker without known pricing starts under a $1 hard ceiling. Its usage is not added to the parent's spend; the candidate merely adds an unpriced note afterwards. A note cannot enforce the required combined cap. The priced-usage control confirms that the same seam accounts $1 correctly with known pricing, and a ceiling already reached refuses before dispatch.
- After recording 24 children for a still-active turn, activity in 256 other sessions evicts its ledger row. The same turn then reads zero children. This violates a hard limit across the shared runner; eviction must not forget active ownership. This synthetic ledger test does not claim that one model can create 256 operator sessions.

The depth control confirms that a worker ID cannot launch another subagent. All 50 existing candidate subagent tests pass, including the upstream test corrections; these tests intentionally permit unpriced cloud execution and bounded-ledger eviction. The three [absence assertions](../../src/tools/subagent-deferred.test.ts) fail on that candidate and pass on the fork integration. See [candidate absence result](c1e-absence-red.json).

## Before reopening

First reproduce a failure, then adapt each boundary against the fork integration candidate:

- Account every paid leg, including unknown-price providers and auxiliary calls, through the parent's request-budget ownership. Refuse an unaccountable paid leg under a hard ceiling. Do not replace the fork's stronger request accounting with completion-only estimates.
- Keep depth, child counts and spend bound to the whole active tree and originating turn until cleanup; do not evict active-turn ownership to maintain a cache bound. Profiles and tool arguments must not raise these ceilings.
- Route approval to the person owning the originating turn. Retain dispatch approval, read scope, original-input guards and cancellation. Test parent deny/personal levels, isolated always grants, inability to approve as a child and no broadcast to unrelated presenters.
- Keep normalized write grants tied to the approved turn and canonical folder, with parent traversal, symlink and Darwin/Windows case tests. Turn completion, cancellation and a new turn must revoke them.
- Verify agent-child restrictions with actual subprocesses: no admin routes, secret access or configuration writes. Carry incognito/no-memory, project constraints, every provider/egress guard, offline and Privacy Shield to every leg.
- Preserve the already-locked sidecar executeTurn seam, production array grammar/profile/parser/transport agreement and nonce-framed worker results. Test cancellation of actual child processes, not only a mocked abort callback.

Passing C1a-C1d tests does not assert that this deferred execution surface meets these unimplemented conditions. No downstream slice in the requested C1 chain remains to import after C1e.
