# Durable cross-session memory

Status: current
Owner: src/memory/

This area owns durable cross-session memory. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [memory-store.ts](memory-store.ts)
- [profile-store.ts](profile-store.ts)
- [memory-context-provider.ts](memory-context-provider.ts)
- [reflection-runner.ts](reflection/reflection-runner.ts)

## Ownership and dependencies

MemoryStore and specialized profile/link/lesson/procedure/vote stores own persistence. The context provider retrieves bounded prompt material; reflection and its runners form or curate durable data; consolidator owns scheduled distillation. Runtime supplies provider/slot posture and shutdown; prompt owns placement and budgets. Read retrieval and formation independently.

Each model completion in these runners uses a fresh Privacy Shield archive. Each distilled cluster owns its archive even though all clusters retain the `consolidator` routing partition. Reflection, rewriting, links, votes and reconciliation likewise keep routing identity separate from the per-call archive; concurrent clusters or calls cannot restore another call's private placeholders.

No durable store holds a credential: profile, note, lesson and procedure writes go through [memory-secret-guard.ts](memory-secret-guard.ts) (the shared [credential detector](../error-reporting/secret-detector.ts), the agent's own `.env` values, and labelled phrases such as "password: X", "the wifi password is X" or "API key: <hex>" that only memory refuses) and are refused with the store's validation error, which never echoes the value. Profile keys that name a credential (`*_api_key`, `*_token`, `*_password`) are refused too (`*_pat` only after a service such as `github_pat`), and a key and value are also read together (`pin` = `4821`); `remove`/`history` still accept them so a legacy row can be cleaned up.

## Backup and entry state

Housekeeping history from upstream #1708 remains deferred in B7a1. No lesson/procedure undo, eviction history or merge splitting is enabled. [Audit and reopening conditions](../../docs/reviews/b7a1-memory-history.md).

[Backup and restore](memory-backup.ts) provide the shared CLI and TUI operations. A backup stages a consistent SQLite snapshot privately, checks stored values for credentials, rebuilds full-text indexes, and publishes the completed database atomically into a new private directory. Restore validates the schema and merges notes and active facts in one write transaction, preserving constraint scopes and disabled state. The target maintains its own search index and rebuilds embeddings through the normal backfill. Project files under `.atomic/project/lessons/` are outside this store.

An optional `disabled_at` column on notes and profile facts keeps entries available for person-operated listings while filtering them out of prompt retrieval and consolidation. Toggling records a reversible change in [the journal](evolution/memory-change-log.ts). An active profile fact carries its state forward to the next version.

## Task-specific reading

Read docs/retrieval.md for recall and docs/formation.md for reflection/consolidation; ../prompt/AGENTS.md for rendering.

## Validation

`npx vitest run src/memory`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
