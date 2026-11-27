# Turn preparation, recovery and finalization

Status: current
Owner: src/agent/turn/

Read [agent instructions](../AGENTS.md) and the [module route](../README.md). Entry: [turn-preparation.ts](turn-preparation.ts).

Synchronous preparation surrounds the original memory/profile awaits in agent-loop.ts. turn-state.ts owns the mutable counters and retry state; turn-recovery.ts classifies failures and returns a narrow decision. Waiting remains explicit in the loop. turn-memory-context.ts owns recalled context and its allowlists; turn-finalization.ts records the existing completion/failure effects and drains steering. Parse, empty, size and truncation helpers are the sole rule owners; out-of-memory-recovery.ts owns the restart of a local model that ran out of memory (ask or halve the window, retry the step). turn-checkpoint.ts hands each completed, non-terminal step to `RunTurnOptions.onStepCheckpoint` (the runtime's per-step write, ATO-1109); a failing checkpoint is logged, never fatal.

Checks: `npx vitest run src/agent`; `npm run lint`; `npm run typecheck:tests`. Read [batching](../docs/batching.md) for dispatch or [recovery](../docs/recovery.md) for retries and progress.

Recovery treats `start_pending` without a lock owner and without a model process as a bounded pending start: it keeps waiting past the dead-engine 8-second grace and produces `LocalEngineDownError` at `LOCAL_ENGINE_NO_PROCESS_CEILING_MS` (90 seconds). The pending marker does not imply a live engine-lock owner.
