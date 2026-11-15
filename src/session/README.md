# Session state and persistence

Status: current
Owner: src/session/

This area owns session state and persistence. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [session-state.ts](session-state.ts)
- [session-store.ts](session-store.ts)
- [conversation-turn.ts](conversation-turn.ts)
- [session-retention.ts](session-retention.ts)
- [turn-owner.ts](turn-owner.ts)
- [turn-progress.ts](turn-progress.ts)

## Ownership and dependencies

SessionState holds turns, loaded descriptors and transient recalled context; SessionStore persists the chat and turn ownership. Retention owns bounded cleanup of eligible inactive sessions; [session pins](session-pins.ts) from `tasks.sqlite` and `webhook-sessions.json` are never pruned. A missing pin file pins nothing, but one that exists and cannot be read or parsed throws `SessionPinsReadError`, and the runtime skips that boot's prune with a warning instead of pruning with an empty keep-list. The skip repeats every boot until the file reads, so the warning and `atomic-agent doctor` (check `session-pins`) name the file and its fix (`describeSessionPinsFix`). A corrupt `webhook-sessions.json` is moved aside to `.corrupt-<time>` by the webhook store at boot (its bindings are unusable anyway), so the next boot prunes again; a corrupt `tasks.sqlite` is never touched. Runtime controls execution and memory stores own durable facts, so a session snapshot must not be treated as either executor or memory database.

The optional version-1 [cloud context journal](cloud-context.ts) records the exact model-visible history and state updates in the existing session JSON. It has stable transcript-based call IDs, a processed transcript boundary and a boundary hash; old sessions initialize it on their first cloud build. Assembly extends it without mutation, runtime persists it before inference, and preview never commits. Current recalled inputs remain transient, but messages already shown to a cloud model remain journaled. Complete output increases stored session size; retention still applies to whole inactive sessions. Switching to local leaves the journal intact and uses the local projection; previously clipped local records cannot be reconstructed.

## Task-specific reading

Read README.md for state/retention changes; ../runtime/docs/lifecycle.md for concurrency and shutdown.

## Validation

`npx vitest run src/session`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).

[Session compaction](session-compaction.ts) owns checkpoint validation and the shared history projection. The full transcript stays intact; semantic coverage and mechanical pack cuts have separate boundaries. Runtime owns [summarization and checkpoint persistence](../runtime/docs/compaction.md).

[Turn progress](turn-progress.ts) (ATO-1109): `executeTurn` marks a turn's progress when it starts and checkpoints the transcript with the marker after every completed step (`SessionStore.checkpointTurn`, one row write guarded on the turn's own mark). A turn that ends on its own clears the marker; one that ends `cancelled`, or whose process died (the boot sweep ends the row and keeps the marker), keeps it so the work can be continued. The task runner continues tasks cut off by a crash or a restart; nothing continues a turn a person stopped. A chat turn a restart cut off ([interrupted-chat-turn.ts](interrupted-chat-turn.ts), ATO-448) is never continued on its own and is offered only when the operator started it (the marker's `options.origin` is `tui`, `cli`, `http` or `sidecar`; a legacy marker without one, only when `interactive`), never a Telegram, Discord or scheduler turn whose words `/resume` would replay as the operator's: opening its session in the TUI shows a one-line offer, and `/resume` (`AgentRuntime.interruptedTurns`, the same entry point for the desktop or an HTTP client) sends one continuing turn, starting with a note that tools may or may not have completed and side effects must be checked before they are repeated. A cut-off Fusion orchestrator turn with a resumable run written during it gets that run's `/fusion resume` message instead, so the workers' checkpoints are used rather than a fresh fan-out. Taking it marks the turn "resume queued" in memory, so it is offered once; the continuing turn replaces the marker when it starts, and a resume dropped before that (queue cleared, run stopped, session switched) is offered again. `/resume` and `/fusion resume` share one queued mark per Fusion run (the second says it is already queued): a second resume of a run that has since completed would reach `fusion.delegate` as `resume-unknown`, whose answer tells the orchestrator to plan the work again.

[Archived chats](session-archived.ts) (ATO-1150): `metadata.archived: true` marks a chat the operator put away, with `metadata.archivedSetAt` stamping every archive and unarchive. `SessionStore.setSessionArchived` sets it; `save`, `finishTurn` and `checkpointTurn` keep the stored flag over a copy with no stamp or an older one, as for a renamed title. `SessionSummary.archived` carries it to the lists. Not the turn archive (`turn-archive.ts`), which is storage for compacted turns.

[Chat export](chat-export.ts) (ATO-1054): one chat as Markdown (messages, replies, one line per tool step, delivered files; no reasoning or raw tool output), and HTML ([renderChatHtml](chat-export.ts), raw HTML shown as text, CSP blocks loads) or DOCX ([chat-export-docx.ts](chat-export-docx.ts), minimal OOXML zipped with JSZip) built from that Markdown. Every exported line (title, messages, tool-step lines) goes through the shared credential detector (`maskSecrets` in [secret-detector.ts](../error-reporting/secret-detector.ts), plus the secret-named values of `process.env`) before it is written. Used by `atomic-agent export` and `GET /api/sessions/{id}/export`.

[Session titles](session-title.ts): the namer writes `metadata.title` once, after the first answered turn, and never renames. The operator can ([session-title-user.ts](session-title-user.ts), `SessionStore.renameSession`): that title carries `metadata.titleSetByUserAt`, and `save`/`finishTurn` keep it over any copy without the stamp or with an older one, so a stale snapshot cannot undo a rename.

[Incognito chats](incognito.ts) (ATO-586): `incognito` on the state, fixed at creation (`run --incognito`, TUI `/incognito`, HTTP `incognito: true` on a new chat; on an existing ordinary chat it is refused with 400, and an existing incognito chat stays incognito whatever later requests say). No memory is written from one (removals refuse too), no list or search shows it, and its fusion workers are incognito too; it is deleted with its archived turns, trace, tasks and fusion run checkpoints when closed (`runtime/incognito-sessions.ts`; the HTTP server closes the ones its chat completions opened when it closes), or at the next boot once its owning process is gone (`SessionStore.sweepOrphanIncognito`). While a store has an incognito chat open its connection runs with `secure_delete` on (freed pages are zeroed), and deleting one checkpoints the WAL (`wal_checkpoint(TRUNCATE)`), so the chat's text stays in neither file; filesystem-level copies (journaling, SSD remapping, backups) are outside what SQLite can reach.
