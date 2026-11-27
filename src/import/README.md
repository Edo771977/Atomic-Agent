# External agent import

Status: current
Owner: src/import/

Imports sessions, skills and notes from other agents. AGENTS.md in the Codex importer is an external input filename, not a reference to this repository guide; do not rename it during documentation migration.

The [atomic-desktop](atomic-desktop/atomic-desktop-importer.ts) source is not another agent: it merges the desktop app's former state dir into the shared one (ATO-416) through the store APIs; see the [CLI guide](../cli/README.md#desktop-state-merge).

Projects and folders: every session importer tags each session item with the group it had at the source (the folder it ran in, or a Claude app project), and [grouping.ts](grouping.ts) turns those tags into desktop Projects (`projects.json`, when the folder exists on this computer) or chat Folders (`chat-folders.json`), idempotently. `atag import` and the TUI run it after each importer (`groupImportReport`); the group rows land in the report as `projects` / `folders` items.

Two sources are not another coding agent's state dir: [claude-app](claude-app/claude-app-importer.ts) reads the Claude data export (.zip or its folder; claude.ai and the Claude desktop app), and [atomic-agent](atomic-agent/atomic-agent-importer.ts) reads another Atomic Agent data folder, keeping its projects and folders as they were. A provider it brings over never keeps its `apiKeyCommand`, with or without secrets: that is a program the agent would run, so the report says to check it in the source's `config.json` and add it back by hand ([drop-api-key-command.ts](atomic-agent/drop-api-key-command.ts), ATO-1716).

Entry point: [index.ts](index.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

C3a keeps chat-export facts extraction (#1584) deferred. The collector, extractor and saver remain unavailable until operator approval, runtime credential masking and enforced output limits are established. Existing session importers remain available. [Evidence](../../docs/reviews/c3a-user-facts.md).

C3b also defers the background facts service (#1642), including its loopback-only classification and test-typing follow-ups: archive limits, read admission, job scope, disabled memory and operator approval must be established together. No facts receipt directory is created. This does not harden the existing Claude session importer; the review exercises that reader only as reused by the deferred service. [Evidence](../../docs/reviews/c3b-import-jobs.md).

Checks: `npx vitest run src/import` when tests are present; `npm run lint`; `npm run docs:check`.

Atomic Desktop import skips incognito tasks and tasks bound to incognito source chats, including legacy tasks without the privacy flag. The session privacy check reads the source snapshot even for a tasks-only import. Skipped tasks and their run history are not copied; only their count enters the summary.

Hermes Python plugins are not executable imports in this fork. Upstream #1639 is deferred pending operator TUI trust bound to plugin content, protected plugin/shim writes and sandboxed egress. [B6a review and reproduction](../../docs/reviews/b6a-hermes-bridge.md).
