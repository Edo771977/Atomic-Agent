# Using durable memory

Status: current
Owner: src/memory/

Memory is separate from the chat transcript. Profile facts, freeform notes, links, lessons and procedures live in bounded local stores. The prompt gets selected facts, recalled previews and indexes rather than the entire store.

Use the TUI Memory area to inspect/manage the stored channels. Notes can be recalled explicitly through memory tools; profile facts have history. Reflection can form facts/notes after turns, so it can be asynchronous rather than an immediate echo of the last message.

A deterministic grounding guard skips reflection for probes and one-off instructions (for example, "Reply exactly OK", "hi", or "ping"). It rejects facts or notes that invent a user name, describe the assistant itself, or turn a one-off command into a lasting preference. Name-like profile facts stay out of the prompt until checked against actual stored user messages; unchecked facts are retained in storage.

Current defaults enable profile, notes, reflection, recall/index injection and query rewriting. Embedding recall, typed-note extraction and segmented reflection are optional and disabled by default. Installed configuration can differ after overrides/migration; inspect your actual settings before diagnosing behavior.

A folder listed in `projects.constraints` (see the README's "Confidential folders") keeps its memory to itself: notes, lessons, procedures and profile facts written there are recalled only in sessions of that folder (or of one restricted to a subset of its providers), never in other chats. A session elsewhere cannot overwrite or delete them, and memory maintenance for them uses only the providers the folder allows.

Deleting a chat is not the same operation as deleting durable memory. Review what the selected memory operation changes. Do not store secrets as facts.

## Disable or re-enable an entry

In the TUI, open `/memory`, select a note or profile fact and press `d`. Disabled entries are marked in the unfiltered list and stay out of agent recall, search and prompts. In the CLI, use `atomic-agent memory list note` or `atomic-agent memory list profile`, then `atomic-agent memory disable note <id>` or `atomic-agent memory disable profile <key>`. Use `enable` with the same arguments to reactivate it. `atomic-agent memory history` displays the journal and `atomic-agent memory undo <change-id>` reverses a change.

The CLI lists notes in pages of 200. Use `atomic-agent memory list note --offset 200` for the next page. Entries written under a confidential folder policy require that folder’s scope and are omitted from the global CLI list.

## Back up and recover memory

Run `atomic-agent memory backup [--out <directory>]` or `/memory backup [directory]` in the TUI. The result contains a private `memory.sqlite` and `RESTORE.txt` under the chosen directory or under the state directory's `backups/`. The destination is reserved exclusively and the completed database is published atomically. It is refused if the memory scanner detects a credential.

Preview the merge with `atomic-agent memory restore --from <directory>` or `/memory restore <directory>`. Confirm with `--yes` (before the directory in the TUI). The CLI can cap a partial restore with `--max-notes N` and `--max-facts N`, where zero omits that collection. Existing entries win. Repeating the operation does not duplicate entries. Older schemas are migrated on a temporary copy. Newer schemas are refused. Memory lessons, procedures, links and votes stay in the snapshot. The backup excludes the source change journal. The restored notes are searchable and can be embedded again with `atomic-agent memory reindex`. Project lessons in `.atomic/project/lessons/` belong to the project folder. Incognito sessions and tool subprocesses cannot run backup or restore.

For implementation work read [memory](../../src/memory/README.md), [retrieval](../../src/memory/docs/retrieval.md), [formation](../../src/memory/docs/formation.md), and [configuration](../../src/config/docs/compatibility.md).

Restore skips consolidated notes and notes marked superseded. The backup still contains those rows.
