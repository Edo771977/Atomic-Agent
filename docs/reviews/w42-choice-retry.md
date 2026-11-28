# W4.2: auxiliary temperature resend and Codex turn model

Status: current
Owner: docs/reviews/

Base: fork `origin/main` at `c9aaeedad`, independent of W4.1.

## Imported commits

Each source commit was imported with `git cherry-pick -x`:

- #1870: `430a8747e7adf2bcbe1a7ecf1b7fc15d1bfb84a5`.
- #1906: `a8494bfe103f0ae9497cc0e3be8b648cfd0574cd`, `9c3e62a6f2538bfc1d34134af2b82308de92c93b`.

## Fork adaptations

The describe-call conflict retains the fork's model override, native wire conversion and usage reporting. It applies one temperature repair to the selected model and resends through the same transport. The endpoint, headers and key are snapshotted before the first await. A supported fixed-temperature lesson stays supported; a forbidden temperature is removed once, and unrelated errors or an already-correct body never trigger that repair.

Every physical OpenAI send rechecks the caller's admission and offline mode outside the network-error retry wrapper. Registry image/audio admission installs a callback that repeats the current provider/project/host policy check. Media provider egress remains governed by `allowedProviders`/`allowedProviderHosts`, as documented in `src/tools/tool-egress.ts`; explicit caller egress admission also runs again. The same `requestBudget` receives both sends and responses, preserving the ledger's existing settlement rules (an explicit unbilled 400 is released rather than inventing a charge).

Each describe attempt masks prompt messages and restores its answer with a fresh Privacy Shield archive. Image/audio bytes are not an OCR or transcription privacy filter. Key and contract probes keep synthetic prompts, snapshot their target, own fresh per-request archives and pass the same optional admission/budget to each request. Their existing request limits remain: three key-check attempts plus at most one temperature resend, and the contract probe's forced/auto/control ladder plus that resend. HTTP diagnostics redact the sent key before creating either the message or parsed body.

The Codex model check runs before Fusion role exceptions and the fork's known-model lookup: team membership cannot bypass it. The entry's configured model remains allowed. The fork's Claude/cloud known-model selection, parent-session role selection and independent reviewer models are preserved. The upstream test conflict is adapted to the fork's `fusionWorker`/`teamChoice` contract, without importing its broader unknown-model acceptance or enabling deferred OAuth. The HTTP documentation conflict retains the fork's interrupted-turn resume ownership contract.

The separate next-step endpoint remains deferred: no environment setting, endpoint or credential flow from #283 is enabled.

## Test-first evidence

Before production changes, the base failed the Codex test and the upstream auxiliary retry tests: eight failed assertions plus the absent new helper suite. The additional safety tests failed against the raw upstream port for endpoint mutation, missing policy/admission/offline rechecks, absent archives, unrelated-parameter retries and echoed credentials. Four separate probe safety tests failed before forwarding admission/budget and adding request archives.

- `src/llm/provider/openai/auxiliary-temperature-safety.test.ts`: same provider/endpoint/key; provider policy, missing project frame, caller egress, offline, distinct archives, both physical budget admissions, unrelated refusals and second refusal.
- `src/llm/provider/verify/auxiliary-probe-safety.test.ts`: admission repeated and per-request archives/budget across key and contract probes.
- Imported temperature tests cover image requests, known/gateway models, remembered rules and explicit fixed-value lessons.
- `src/runtime/per-turn-codex-refusal.test.ts` and `src/runtime/composition/runtime-turn-service.test.ts`: Codex refusal before enqueue, provider variant or loop/client work; supported model choices preserved.
- Existing per-turn, Fusion routing and request-budget suites retain the fork's independent model/reviewer and physical accounting contracts.
- Existing `src/runtime/composition/next-step-endpoint-deferred.test.ts` guards the absence of #283.

Only the W4.2 triage rows and proposed-order row are updated. No chat-export, worker/profile, scheduler or conversation-packer implementation is changed. All fixtures are disposable; no real provider is called.

## Final checks on 28 November 2026

`npm ci`, `npm run lint`, `npm run imports:check`, `npm run typecheck:tests` and `npm run docs:check` passed. Test type debt remains 669 diagnostics, with no new error.

The required full-area command completed: **6 failed | 475 passed (481) files; 7 failed | 6260 passed | 20 skipped (6287) tests**. The suite is **not green** on this Windows account. All failing assertions were reproduced on the unchanged `c9aaeedad` main snapshot: missing symbolic-link permission (including Linux archive links), the existing Windows write-out fixture, and, when it occurred, the existing CLI child-start timeout. There are no unexplained failures, no new skipped tests and no quarantine changes. The earlier transient network-timing failure did not repeat in the final W4.1 run.

The separate `next-step-endpoint-deferred.test.ts` run passed all three tests on both branches. [Machine-readable check summary](w42-verification.json).
