# Inference protocols and model profiles

Status: current
Owner: src/llm/

This area owns inference protocols and model profiles. Read [AGENTS.md](AGENTS.md) before changing it.

The provider registry keeps defensive construction-entry snapshots and exposes credential-free identity fields only after a successful build or replacement. Measured Fusion routing compares those loaded fields with current configuration. `LlamaServerProvider.textRequestBaseUrl` instead reads the actual shared text client's effective base (its pinned override or current local URL); its vision entry URL is separate. Together with the tracked `chatModelId`, this supports known managed-local history without claiming remote served-weight attestation.

## Entry points

- [model-profile.ts](model-profile.ts)
- [profile-invariants.ts](profile-invariants.ts)
- [server-template-policy.ts](server-template-policy.ts)
- [llama-server-client.ts](llama-server-client.ts)
- [dry-sampler.ts](dry-sampler.ts): the opt-in DRY anti-repeat fields for `/completion` (`localModels.drySampler`)
- [slot-manager.ts](slot-manager.ts)
- [toolcall-bench/](toolcall-bench/index.ts): the fixed tool-call reliability prompts, their scoring, and asking one question to several models (`models toolcall-bench`, `models ask`)
- [transport-deadlines.ts](transport-deadlines.ts) and [offline-network.ts](offline-network.ts): the process-wide HTTP pool and the offline-mode kill switch composed into it ([offline mode](docs/offline-network.md), ATO-1084)

## Ownership and dependencies

Model profiles connect prompt framing, grammar and streamed parsing. Provider adapters own transport-specific request/response formats; fallback owns per-session provider stickiness and probes. SlotManager coordinates local inference resources while runtime owns wiring. Inspect provider/openai for strict or tagged schema changes and grammar for constrained local decoding.

## Task-specific reading

Read docs/profiles.md for framing/grammar and docs/fallback.md for reliability; provider/openai tests for wire/schema changes.

Read [subscription OAuth primitives](provider/subscription-oauth/README.md) before wiring any subscription sign-in; they are not used by a provider yet.

Read [model behavior mode](docs/model-mode.md) for the explicit local/cloud policy flag, configuration precedence, per-turn lifetime and full cloud context. Native message IDs remain stable across checkpoints; the final OpenAI body checks messages, schemas and output reserve against a known cloud window before sending.

Read [the native Anthropic provider](docs/anthropic-messages.md) for the `anthropic` kind (`POST /v1/messages`): why it is raw HTTP over the shared transport, the request/response mapping, prompt caching, effort and the migration of old preset entries.

Read [per-folder provider constraints](docs/provider-policy.md) for `projects.constraints` enforcement: the AsyncLocalStorage policy frame (`runWithProviderPolicy`, `currentProviderPolicy`), `ProviderNotAllowedError` / `isProviderNotAllowed`, the guard the registry puts on every provider and how the fallback chain skips disallowed links.

Read [router/README.md](router/README.md) for the opt-in rule-based model router (`llm.router`, ATO-483): it puts a provider first in a turn's fallback chain by request features and stays silent under the local run mode, Fusion or a pinned turn.

A provider rejection that identifies an invalid sampling setting stops failover and names the setting to correct. Network failures and HTTP 5xx still follow the configured fallback policy. Fusion workers keep the provider and model pinned to their turn. See [provider fallback](docs/fallback.md).

## Validation

`npx vitest run src/llm`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
