# C1b: shared worker runner

Status: current
Owner: src/tools/fusion/

Imported in order with cherry-pick -x: d08f267468c2641149c23ad0564ad0042596e8aa, 87de14b162878cf9f8e0aadce82c6e9095cea864, 34fa9b554a5bdba3c80d2d93f12a2b329d6de93f.

Before import, the shared-core and origin tests have four failures (one control passes): no core entry and escalation still reports fusion. The additional fork experience-origin test fails before the adaptation: draft instead of skip. After adaptation, the core/origin, next-step and turn-service tests pass. Existing experience draft failures are compared by name with main in the final checks.

The type extraction uses the fork's interfaces, preserving original-project ruleWorkdir, request-budget bind/unbind, workspaceTrustDir, taint hooks, declared inputs, check authorization/integrity, task permits, project lessons, measured routing and watch controls. The fork uses model instead of turnModel, and supports unbounded reasoning. No runner implementation or already-locked sidecar queue seam is replaced. This PR touches worker-runner.ts, shared with parallel Fusion work.

## Origin inventory

Reproduce with `rg -n '"fusion"' src --glob '*.ts' --glob '!*.test.ts' --glob '!*.test.tsx'` and inspect origin uses. Production checks are:

- runtime/composition/runtime-turn-service.ts: human analytics/usage skip; both worker origins excluded. Its local-model branch uses readFusionWorkerMeta, preserving fork identity/known-model checks instead of authorizing by origin. answerChannelForOrigin and isAttendedTurn use positive human-origin lists, so both worker origins remain unobserved/unattended.
- runtime/composition/runtime-next-step.ts: both excluded.
- runtime/composition/runtime-experience-review.ts: both excluded (fork-only adaptation).
- runtime/turn-controller.ts: union includes both.
- tools/fusion/worker-runner.ts: initial turn and escalation replacement take the same origin, default fusion.
- session/interrupted-chat-turn.ts: positive operator-origin set excludes both.
- prompt/answer-style.ts: positive channel mapping gives neither an answer channel.

Other fusion matches describe run mode, tool names, project records or UI channels, not turn origins. Subagent tool registration is not part of C1b.
