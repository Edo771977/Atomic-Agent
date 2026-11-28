# C1a: worker session depth

Status: current
Owner: src/session/

Base: origin/main `7511497b02504f81ffa03ec8f63367119fdaa6d8` (B1 merged). Upstream: `69dc95c37464dc97e10ef734456f655a7f3e8701`, imported with cherry-pick -x.

Before import, both tests in `src/session/fusion-worker-depth-boundary.test.ts` fail because depth is missing. Afterwards these and the 13 worker-session tests pass. Runtime session factory coverage also passes (23 tests).

The conflict is resolved by retaining operatorRequest and providerPolicy, including fail-closed malformed policy and provider host/egress limits. StampedFusionWorkerMeta requires only depth, not all optional fork fields. Unsafe integer depths are malformed. Existing request assertions are extended by depth rather than weakened. The Fusion runner file is shared with the parallel B7 work and is explicitly part of this import; only its two session metadata constructors and import change here.

This change does not enable subagents or increase permissions. Final series checks are recorded in the series review.

The requested broad run also caught the fork's exact whole-request assertion in fusion-delegate.test.ts: its expected metadata omitted the new depth field. The test failed with the added field, then passed after both expected worker stamps gained depth: 1. The exact operatorRequest assertion is retained; no production change was needed.
