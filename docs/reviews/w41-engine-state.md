# W4.1: local engine state and delayed Core exit

Status: current
Owner: docs/reviews/

Base: fork `origin/main` at `c9aaeedad`. This branch is independent of W4.2.

## Imported commits

Each source commit was imported with `git cherry-pick -x`:

- #1799: `bbfdab16709cbbd2edab7183e238266a56263078`, `ef40ae46c79524d545d09cf8b587c3f85b675603`.
- #1805: `a8637cbc31439eb0285ce22efde9de96b229bc1c`, `72ca915115dd59d16fdeffa0d83e2ef3409db511`.

## Fork adaptations

The upstream 401 path refreshed the key first and retained the foreign response and cause. The fork reads its lock-aware engine state before attaching credentials: `gone` sends no key, and a 401 gets no key refresh or retry. Its message is fixed, without the response body, foreign process identity or raw cause. An unknown engine, start or load keeps the existing key handling and recovery policy. The existing liveness diagnostics and 90/270-second ceilings are unchanged.

The daemon conflict keeps the fork's `chatServerTarget` helper and applies the awaiting-exit guard there; it does not replace the helper with upstream's older inline cache-save implementation. Pending records cannot revive through a delayed Core status or supply a refreshed key. Loads wait under the existing operation lock before opening Core, including a new port for the same role, so they cannot overwrite a still-needed record. Another role on a free port remains usable. No new process termination path is added.

## Regression evidence

Tests were added and run before production changes. On the base, the foreign-port tests sent credentials and retried; the delayed-exit tests lost `core/chat.json` while the simulated server still lived. The initial run had seven failed assertions and one missing new-module suite. Additional tests failed against the unadapted upstream port when it connected to Core too soon, overwrote a pending role on another port, or revived it through a delayed snapshot.

- `src/llm/llama-foreign-port-security.test.ts`: unary and streamed 401, one anonymous request, no refresh, no secret/body/identity/cause.
- `src/llm/llama-own-engine-state.test.ts`: managed port only; live, gone, held lock and pending start remain distinct.
- `src/local-llm/core/core-pending-exit.test.ts`: real disposable child with simulated delayed Windows unload; record retained, no premature load/Core/orphan recovery, no old or refreshed key, no foreign-session unload or signal, record removed only after release.
- Existing `src/agent/turn/turn-recovery-local-engine.test.ts`: start/load waits, ceilings and `LocalEngineDownError`.
- Existing `src/tui/local-models/start-pending-lifecycle.test.ts`: managed-only marker and settlement on cancellation/failure.
- Existing Core operation, session and retired-session suites cover lock ownership and matching before unload.

Tests use disposable state and mocked Core control, without starting a model server or touching personal model data. The delayed process runs on Windows; this is not a live Atomic Core acceptance test.

The branch changes only the two W4.1 triage rows and its proposed-order row. Chat export, worker/profile, scheduler and conversation-packer work are untouched.

## Final checks on 28 November 2026

`npm ci`, `npm run lint`, `npm run imports:check`, `npm run typecheck:tests` and `npm run docs:check` passed. Test type debt remains 669 diagnostics, with no new error.

The required full-area command completed: **5 failed | 474 passed (479) files; 6 failed | 6249 passed | 20 skipped (6275) tests**. The suite is **not green** on this Windows account. All failing assertions were reproduced on the unchanged `c9aaeedad` main snapshot: missing symbolic-link permission (including Linux archive links), the existing Windows write-out fixture, and, when it occurred, the existing CLI child-start timeout. There are no unexplained failures, no new skipped tests and no quarantine changes. The earlier transient network-timing failure did not repeat in the final W4.1 run.

The separate `next-step-endpoint-deferred.test.ts` run passed all three tests on both branches. [Machine-readable check summary](w41-verification.json).
