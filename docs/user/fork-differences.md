# How this fork differs from upstream

Status: current
Owner: docs/user/

This fork (Edo771977/atomic-agent) starts from [AtomicBot-ai/atomic-agent](https://github.com/AtomicBot-ai/atomic-agent).

## Last sync with upstream

The fork was last brought in step with upstream on 17 November 2026:

- `main`: [#57](https://github.com/Edo771977/atomic-agent/pull/57), a one-time merge of upstream `main`, tracked in [#56](https://github.com/Edo771977/atomic-agent/issues/56).
- The desktop line: [#61](https://github.com/Edo771977/atomic-agent/pull/61), upstream `desktop-v0.0.9` merged into `desktop-main`, tracked in [#59](https://github.com/Edo771977/atomic-agent/issues/59).

After that merge, the upstream batch [#1740](https://github.com/AtomicBot-ai/atomic-agent/pull/1740) comes in one change at a time with `git cherry-pick -x`, in the series of [#233](https://github.com/Edo771977/atomic-agent/issues/233).

- Each imported change has a review and tests that failed before the import.
- Changes that do not yet meet the fork's rules (credentials, external content that starts turns, external protocols) are held back. Each one has reproducible evidence in `docs/reviews/`.
- [upstream-2026-11-triage.md](upstream-2026-11-triage.md) records, for each upstream change, whether it was imported, with which pull request, or why it is held back.

W1.1 selectively imports upstream #1776 and #1788: a static own-computer persona line and an offline RAM bench fixture. The fork uses a fictional 16 GiB computer described only by computer.json in the temporary workspace; the checker reads captured replies and constants, not host hardware or outside files. The model matrix and profiles remain those of main. No dependencies or install hooks change. Four-mode pre-port byte comparisons and independent-session checks guard the stable prefix.

These imports are new commits, so GitHub's "commits behind" count against upstream does not go down. The triage is the reference for what is imported.

Selective imports for offline use and chat data cleanup:

- `fix/ato-1085-offline-telemetry` (`1ab6b946dbaa8e458aca8e7c675bd930e9b84b72`): drop telemetry, feature flag lookups and update checks in offline mode.
- `fix/ato-1501-delete-file-checkpoints-with-chat` (`7fb250af1a6fd7334ee3f0f553fb046669ba5f08`): delete file checkpoints when a chat is deleted. The test conflict was resolved by keeping both the fork's `TaskStore` import and the upstream `FileCheckpointStore` import.

- `fix/ato-1547-incognito-tasks-after-crash` ([#1595](https://github.com/AtomicBot-ai/atomic-agent/pull/1595)): the boot sweep removes the abandoned chat’s tasks before task recovery and keeps failed cleanups eligible for retry, including when file checkpoints cannot be removed. Fusion checkpoints and spilled outputs use the fork’s existing cleanup.
- Fusion model routing ([#1560](https://github.com/AtomicBot-ai/atomic-agent/pull/1560) and [#1561](https://github.com/AtomicBot-ai/atomic-agent/pull/1561)): legacy legs now send their configured models, and workers can escalate to a different model on the same provider. The fork retains team member selection, reviewer independence and signed receipt attribution.

Selective Privacy Shield imports:

- `feat/ato-599-privacy-shield-detector` (`31592d25ad9f28d75d60b09efdfa68f026331ba1`) and `feat/ato-1081-privacy-shield-providers` (`6a5ae1845c713bed46e0abd6f2faa0d852a8863a`) bring reversible masking to remote OpenAI-compatible providers and native Anthropic Messages. The fork reuses its known credentials and drops the in-memory archive on chat deletion, including incognito close. Enable it with `privacy.shield.enabled`. [Coverage and session behavior](../../src/privacy/README.md).
- ATO-1082 adds the TUI Privacy Shield switch and count-only status. GET /api/privacy-shield requires read scope. POST and PATCH require admin because the persisted default applies to the whole runtime. Changes take effect when each next turn begins. ATO-1083 shares the session archive across covered Fusion cloud calls. Local providers in auto mode receive original values, and incognito uses a private archive that is removed on close. [Toggle](https://github.com/AtomicBot-ai/atomic-agent/pull/1695) · [Fusion](https://github.com/AtomicBot-ai/atomic-agent/pull/1689)

- The HTTP/TUI toggle and the shared Fusion planner/worker archive are deferred.

Earlier upstream PRs came in as batches:

- [#24](https://github.com/Edo771977/atomic-agent/pull/24): 14 upstream PRs (Fusion, local models, approvals, costs, router).
- [#26](https://github.com/Edo771977/atomic-agent/pull/26): batch 2 (local models, pricing snapshot, memory, `/resume`).
- [#27](https://github.com/Edo771977/atomic-agent/pull/27): batch 3 (agent fixes, engine wait, reasoning level, memory flush, superseded notes).
- [#28](https://github.com/Edo771977/atomic-agent/pull/28): batch 4 (offline mode, incognito chats, chat ops, provider presets).
- [#41](https://github.com/Edo771977/atomic-agent/pull/41): batch 5 (`browser.debug`, `ask_user`, LSP diagnostics, skill bins, settings reference, per-turn model).

Anything upstream published after 17 November is not here until it is imported.

The fork imports mandatory `serve` authentication from upstream commit `8e2e65b7c3650d249ec782e8b2fbadf9a3635ffa`. The fork authenticates model discovery and its own project routes, excludes the serve key from agent subprocesses, and accepts explicit keys from stdin or a file. Signed tunnel deliveries without the serve key use `/webhooks/{name}`. See the [HTTP guide](../../src/http/README.md), [upstream triage](upstream-2026-11-triage.md), and [#187](https://github.com/Edo771977/Atomic-Agent/issues/187).

Named HTTP tokens port upstream ATO-583. The fork keeps the serve key as the owner credential, separates human decisions from ordinary agent work, and assigns scopes to fork project and memory routes. Only the person's CLI issues or revokes tokens. The registry is owner-only, stores token digests and is protected by the same tool policy as the serve key. [HTTP roles and route matrix](../../src/http/README.md#named-http-tokens)

The B2 import of `GET /api/discord/channel` exposes status with read scope: no bot identity, no token, no user IDs or message content, and no raw `lastError`. Discord and Telegram return fixed `channel_error` / `channel_locked` codes and `Cache-Control: no-store`; named tokens see only `{ where: "this_computer" }` for a local competing poller, without its PID. The owner can see the PID in `otherPoller`.

The installable phone panel has an explicit Public read exception for fixed static files: `/panel`, `/panel/app.js`, `/panel/manifest.webmanifest`, `/panel/icon.svg` and `/panel/icon-180.png`. They contain no key, chat data or configured host/port; manifest navigation stays `/panel` without query or fragment. They use no-store and restrictive security headers, with document restrictions also on the SVG. No service worker or external CDN is added; data APIs still require authentication. The runtime offline switch adds no outbound requests for these resources, and the local listener must remain reachable. [Panel and route matrix](../../src/http/README.md)

Selective imports for provider and scheduler reliability:

- `fix/ato-1575-cloud-body-after-local-turns` (`53fb64392d9f5e20ecd4ac16d523c61d23ce614e`): omit empty assistant replies from native messages.
- `fix/issue-1735-scheduler-leader-overlap` (`50d34a2544e5eab09dd5b895a0118b2a07b2e6a9`): give the Telegram owner priority for scheduler leadership.

Selective imports for failover, Telegram, verification, and offline CI:

- ATO-1218 (`9e69ac17d535900eecb87ef1f8c3cbd7dbde0c9c`): invalid sampling settings stop provider failover. The fork retains its offline and folder-policy checks and pinned Fusion worker routing.
- ATO-613 (`9665023eedd858495a28cd8645deb737347ff2db`): old Telegram tool approval buttons expire. The message also covers approvals aged out of the recent-history cache, and project lesson confirmations from #179 continue through their own commands.
- ATO-1452 (`f67f29834b1b758d8466042f4cf90714a0b9e61f`): default macOS page verification tries Playwright Chromium first. Both launch paths keep the fork’s browser environment and configured browser cache.
- ATO-1507 (`e594039fc2e41ccbf2f93338b6ddbe13853f9343`): CI runs the built offline smoke with loopback only and checks for zero outbound attempts, including the telemetry, flag and update paths from #188.

The official installer (`curl … atomicagent.io/install`) and upstream's release packages install upstream's code, without any of the changes below. To use this fork:

- Build it from source with `npm ci && npm run build && npm link`.
- For the desktop app, use the `desktop-<platform>` artifact of the fork's **Desktop packages** workflow on `desktop-main`.

Everything below exists only in this fork. Links are to the fork's pull requests.

## Mailbox-triggered tasks

The B5a IMAP ingress (#1702 and #1719) is deferred: ambiguous sender headers, domain-wide auto-start and the trustFromHeader bypass can start unverified tasks, and the credential resolver does not refuse tool children. Existing Atomic Mail behavior and #240 extractor fixes are preserved. [Evidence and reopening tests](../reviews/b5a-imap.md).

## Regeneration history

C2a keeps upstream #1570 deferred. Its candidate retains unbounded archived answer bytes, accepts malformed archive fields, persists extra history in incognito and restores without acquiring turn ownership. Existing rollback behavior remains available. [Evidence and reopening tests](../reviews/c2a-previous-replies.md).

## Chosen folders and file search

C4a keeps upstream #1697 and its vector-scan, interrupted-scan and grammar follow-ups deferred. No chosen-folder index, /api/files routes or files.search tool is enabled. The candidate bypasses protected-input/session-read boundaries and persists credentials before masking; an inherited owner key can add a folder. Existing filesystem and document tools retain their guards. [Candidate evidence and reopening tests](../reviews/c4a-files-index.md).

C4b also defers upstream #1700 with C4a: no automatic sqlite-vec load or reranker setting is enabled. The candidate loads an unpinned writable package and admits LAN rerankers without provider/egress or secret/privacy handling. Its offline blocking and search fallbacks work; the commit adds no memory retrieval integration. [Native-loader and reranker audit](../reviews/c4b-vec-rerank.md).

## Facts from a ChatGPT or Claude export

C3a keeps upstream #1584 deferred: approval IDs can be supplied by an agent child, opaque runtime credentials survive collection, and extraction bounds exist only in the prompt. No facts extraction or save API is enabled. [Candidate evidence and reopening tests](../reviews/c3a-user-facts.md).

C3b keeps upstream #1642 and its follow-up fixes deferred with C3a. No /api/import/facts routes or background import are enabled. The candidate lacks bounded archive admission, durable job scope, memory-enabled checks and token ownership; an inherited owner credential can save. Existing guarded providers and offline transport are preserved. [Audit and reopening tests](../reviews/c3b-import-jobs.md).

C3c keeps the dependent terminal facts step (#1661) deferred. Its candidate checks every fact by default and Enter can save facts outside the only displayed page. The existing import form has no facts review until the predecessor services and explicit unchecked approval flow are established. [TUI audit](../reviews/c3c-tui-facts.md).

C3d keeps the first-run export hint (#1670) deferred because it points to that absent facts step. The hint itself is informational and starts no import or memory write; it can return once the preceding chain is ready. [Onboarding controls](../reviews/c3d-onboarding.md).

## Memory backup and entry controls

B7a1 keeps upstream #1708 housekeeping history deferred: split-merge snapshots lose the original constraint scope and disabled state, and restoration lacks a memory-enabled/operator trust contract. Existing note/profile history remains available. [Candidate evidence and reopening tests](../reviews/b7a1-memory-history.md).

CLI and TUI share an owner-only SQLite backup and a transactional merge for notes and active profile facts. The fork checks the schema, rejects backups containing detected credentials, and keeps each recovered note in its original constraint scope. The terminal lists disabled entries and can re-enable them. State changes are recorded in the memory journal for undo. The HTTP archive connection and entry toggle API are pending. See [using durable memory](memory.md).

## Separate suggestion model

C2b keeps upstream #1606 deferred, including its HTTP-400 retry and environment documentation. The candidate endpoint bypasses provider/host policy and Privacy Shield, attempts suggestions in offline mode and lacks validated credential/error handling. Existing suggestions through the configured model remain available. [Evidence and reopening tests](../reviews/c2b-next-step-endpoint.md).

## Fusion team

- **Roles.** Director, worker and reviewer, with the director chosen per session ([#42](https://github.com/Edo771977/atomic-agent/pull/42)).
- **A reviewer per task.**
  - It gives a structured verdict and has at most two passes; then the director decides ([#44](https://github.com/Edo771977/atomic-agent/pull/44)).
  - A periodic watch checks that a running worker is progressing and not stuck ([#45](https://github.com/Edo771977/atomic-agent/pull/45)).
- **A chat chooses its reviewer, or none.** An OpenAI Codex (ChatGPT) subscription can be the reviewer, read-only. Adding the first reviewer does not turn review on for every chat ([#72](https://github.com/Edo771977/atomic-agent/pull/72); desktop seats in [#73](https://github.com/Edo771977/atomic-agent/pull/73)).

## Fusion projects with gates

For everyday use, see the [Fusion projects guide](fusion-projects.md).

- **Brief, plan and milestones.** Each one waits for the person:
  - in the TUI and `run` ([#46](https://github.com/Edo771977/atomic-agent/pull/46));
  - in the desktop project card ([#48](https://github.com/Edo771977/atomic-agent/pull/48)).
- **Quality checks beyond tests.** End-to-end runs, automated full games, screenshots and a vision judge. A milestone report lists its criteria and attachments ([#52](https://github.com/Edo771977/atomic-agent/pull/52)).
- **Plan hints and folder checks.**
  - The plan carries hints.
  - A folder that is too broad (the home directory or a drive root) is refused as a session folder.
  - `verify` uses narrower copies.

  See [#55](https://github.com/Edo771977/atomic-agent/pull/55).
- **A new chat inside an existing project** in the desktop ([#64](https://github.com/Edo771977/atomic-agent/pull/64)).
- **Stricter gates.**
  - A milestone that cannot be verified comes back to the person.
  - The plan row's reviewer is the one that reviews that task.
  - A hard cap stops at a plan gate.

  See [#75](https://github.com/Edo771977/atomic-agent/pull/75).

### A project lives in its folder

- **The project is in the folder, not in the chat.** Brief, plan, milestones and their evidence are in `.atomic/project/project.json`, with `BRIEF.md`, `PLAN.md` and `STATUS.md` beside it to read. Deleting a chat keeps the project; a new chat in the same folder finds it, and several chats share it. The folder is meant to be committable; nothing secret is written there.
- **Your approvals and the project's progress are kept on your computer, not in the folder.** The folder's file holds what you approve (brief, plan, milestone names); which milestone runs, its runs and its evidence are kept beside your approvals. If you or a command edit the brief or the plan in the file, that gate waits for you again, and so does everything that depended on it; `--auto-approve-project` stops at such a gate. Editing a milestone's state or evidence in the file does nothing.
- **A copy starts over.** A project copied to another computer or folder opens with its brief, plan and milestones; its runs, evidence and gates start over there, and it becomes a project of its own.
- **Incognito chats keep their project in the chat** and leave nothing in the folder.
- **Two chats cannot approve the same gate twice.** The second one is told the gate was already decided.
- **Old chats move over on first open,** with their approvals, verdicts and evidence.
- **`atomic-agent projects list`** shows each project with what waits for you and what is next; **`atomic-agent project resume <folder>`** opens a chat on it at the waiting gate. A damaged file, or one written by a newer version, is reported and not opened.

### Milestone verdicts stay tied to their work

- **A material change to a milestone's work resets its verdict.** A changed kind, or a task added, removed, moved or retitled, sends it back to planned. Its old evidence moves to a short per-milestone history. Editorial changes keep the verdict: the title, the order, or a task's worker, reviewer or estimate. Work that has no verdict yet keeps its runs when tasks are only added. The plan gate says `verdict reset: <title>` ([#78](https://github.com/Edo771977/atomic-agent/pull/78)).
- **Criteria are judged when a brief is approved,** against the last approved brief:
  - A criterion whose text changed resets the milestones that cite it.
  - A removed criterion drops only its own facts and pictures, which go to history with its text.
  - A reused id starts with no evidence.

  See [#81](https://github.com/Edo771977/atomic-agent/pull/81).
- **Projects saved before #81.** Evidence for criteria missing from the approved brief is retired. If no brief was approved, all criteria evidence is retired, because nothing tells which old results still apply. The plan gate says `evidence retired: <title>` ([#84](https://github.com/Edo771977/atomic-agent/pull/84)).
- **Project decisions.** The director proposes decisions with the brief ("SQLite, not Postgres", "no new dependencies"), approved with it. Every task of the plan names the decisions it honours; the plan cannot be approved while an active decision is named by no task, and the plan gate says which. You can defer a decision (or mark it informational) from the plan gate instead (`d` on the TUI card); that is your call, kept with your approvals, and editing `project.json` cannot do it. Workers and reviewers are given the active decisions, and a milestone report lists those its tasks named, as not checked automatically. Approving a brief that changes a decision's text sends the milestones whose tasks named it back to planned, with their evidence in history ([#112](https://github.com/Edo771977/atomic-agent/issues/112)).
- **A plan reviewer before the plan gate.** With `llm.runMode.fusion.team.planReviewer` (or any `reviewers`), a model reads each plan draft against the approved brief: criteria coverage, task completeness, dependencies, size, verifiability, scope, numbers and decisions. A fail goes back to the director, at most `planReviewRounds` times (default 2); then the plan gate shows you the open notes per dimension. You can still approve over them with a note (`o` on the TUI card; the desktop card), which is kept with your approvals; a failing plan check stays a hard stop. `--auto-approve-project` never approves over the notes, nor a plan that was not reviewed (the review could not run, was skipped, no longer matches the plan after your edit, or is missing after an outside edit of `project.json`): you can still approve those yourself. In a folder limited by `projects.constraints` only a reviewer it allows is used; with none the review is skipped and the gate says so. The review's cost counts in the turn budget and has its own line in `fusion report` ([#118](https://github.com/Edo771977/atomic-agent/issues/118)).
- **A project backlog, and ideas with a condition (seeds).** Work that is not ready for the plan stays with the project instead of the chat: say "add to backlog: …" and the director records it (`project.backlog.add`), as it does for its own ideas and for later work a worker or reviewer names in a reply. An item with a condition ("when the PDF export exists") is a seed: each plan and milestone gate shows the open seeds with their condition, and the director tells you which look met. Only you promote, drop or reopen an item (`atomic-agent project backlog [folder] --promote|--drop|--reopen <id>`); a promoted item goes into the next plan through the plan gate like any change, and nothing activates by itself or with `--auto-approve-project`. Your calls are kept with your approvals, never in `project.json`, and bound to the item's text: an item edited by hand after you promoted or dropped it reads open again, and the plan gate says so (also when a promoted item was removed). The calls are refused while a turn runs on the project. Adding an item reopens no gate, and `--auto-approve-project` stops at a plan while an item you promoted waits for it. The director cannot mark an item as yours: one you asked for reads "director (from your message)". The desktop can send the same calls (`project_backlog_decision`, `POST /api/project/backlog`). The TUI card, the gate text and the desktop view count the open items; a project whose milestones are all reviewed says it is complete with the items still open ([#111](https://github.com/Edo771977/atomic-agent/issues/111)).
- **Promoted backlog items are checked in the plan.** A plan task cites the backlog items it takes in (`backlog` on a `project.plan` task). The plan cannot be approved, by you or automatically, while an item you promoted is cited by no task of a milestone that will still run; the gate names it, and a citation on a task of a milestone that already started does not count; a re-plan that drops the citation before the work ran makes the item required again. The gate, the TUI card and `PLAN.md` show which tasks cite each item, its worker gets the item's text, and a complete project names the promoted items never done. You can defer such an item from the plan gate (`edits.backlogStatus` at the gate, over HTTP and the sidecar): it stays promoted but is no longer required, and the choice is kept with your approvals. Only the items the approved plan cites are recorded as taken in by it. Deferring a decision or a backlog item at the gate makes the plan review stale, like your own row edit: its notes stay as notes on an earlier version, you can approve plainly, and `--auto-approve-project` stops ([#146](https://github.com/Edo771977/atomic-agent/issues/146)).
- **One milestone open at a time, across the whole plan.** The daily-cap estimate is computed for the milestone that approval will actually start ([#81](https://github.com/Edo771977/atomic-agent/pull/81)).
- **Run facts are bound to the criterion text they tested.** Each fact in a run's `criteria.json` records the criterion text it was checked against, and a resume uses the texts saved in its checkpoint. A fact whose text no longer matches the approved brief reads unverified, so an old pass cannot close a requirement that changed. A fact with no recorded text stands only while the brief has been approved exactly once. File times are never used ([#88](https://github.com/Edo771977/atomic-agent/pull/88)).
- **Resume accounting.**
  - A resumed Fusion run is admitted on the tasks it will actually run. Rows already finished or awaiting confirmation don't count, and that applies to the orchestrator cap too.
  - Its earlier spend is counted once per run and turn, from what the turn really counted.

  See [#88](https://github.com/Edo771977/atomic-agent/pull/88).
- **Desktop reviewer.** "Add a reviewer…" goes to the chat it was started from ([#79](https://github.com/Edo771977/atomic-agent/pull/79), [#89](https://github.com/Edo771977/atomic-agent/pull/89)). That holds when:
  - the chat changes during the write;
  - the first message is still being sent;
  - the transcript was cleared;
  - the send failed.

The B4d Monid integrations row (#1573) is deferred: a configured server named monid selects a foreign origin for the branded sign-in entry point. The generic MCP catalog entry is unchanged. [Review and reopening requirements](../reviews/b4d-monid.md).

## A2A protocol

A2A discovery and task RPC from upstream #1638 remain deferred in B3. The candidate's task projection does not enforce the fork's chat visibility and disconnecting a blocking caller leaves its task running. The flag and both routes remain unavailable, with no new public exception or role permission. [HTTP review](../../src/http/README.md)

## Chat rollback (rewind)

- **A partial restore keeps the way back.** If any file fails, the rollback answers `409 restore_failed`, with `partial: true` and the lists of restored, deleted and failed files. The chat is not cut and the checkpoint copies are kept, so it can be retried ([#78](https://github.com/Edo771977/atomic-agent/pull/78)).
- **A file that cannot be inspected counts as a failure,** not as "not a file". That covers EACCES, EPERM, EBUSY and EIO, for example a file locked by an editor. A file the agent created is removed after a stat alone. The plan is made again inside the turn lock ([#81](https://github.com/Edo771977/atomic-agent/pull/81)).
- **`skip`.** It leaves the files the person chose exactly as they are. Paths are matched in a normalized form, case-folded on Windows. An unknown path is refused with `skip_unknown` ([#81](https://github.com/Edo771977/atomic-agent/pull/81)).
- **`acceptFailed`.** It finishes the rollback past a failure that keeps coming back ([#78](https://github.com/Edo771977/atomic-agent/pull/78)).
- **The preview's `planHash` and `transcriptRev`.** A confirm sends them back as `expectPlanHash` and `expectTranscriptRev`. If the files or the messages changed since the preview, the agent refuses with `plan_changed`. That includes a "Conversation only" rollback.
  - A file to delete is fingerprinted by its content, up to 64 MiB. Above that, or if it can't be read, it is fingerprinted by stat and flagged `contentUnchecked` ([#84](https://github.com/Edo771977/atomic-agent/pull/84), [#88](https://github.com/Edo771977/atomic-agent/pull/88)).
- **Damaged saved copies are never written back.** Each copy is checked against its stored sha256 first. A damaged one leaves the file as it is and is reported as a failure (`copy_damaged` on `/fs/restore`) ([#88](https://github.com/Edo771977/atomic-agent/pull/88)).
- **A move is not undone into data loss.** When the agent moved a file whose original it did not keep, the moved file stays where it is and is reported as `move_source_not_restored`. Before, it was deleted ([#88](https://github.com/Edo771977/atomic-agent/pull/88)).
- **In the desktop:**
  - The sheet names the files that could not be put back.
  - "Roll back without these files" shows a fresh preview with the skip list before it sends anything.
  - Retry is "Check again", with a fresh preview.
  - Late answers are bound to the sheet that asked.
  - An older agent gets an honest "Roll back anyway".
  - After `skip_unknown`, the person can stop leaving those files out and get a fresh preview.
  - Every confirm carries the preview's fingerprints.

  See [#79](https://github.com/Edo771977/atomic-agent/pull/79), [#82](https://github.com/Edo771977/atomic-agent/pull/82), [#85](https://github.com/Edo771977/atomic-agent/pull/85) and [#89](https://github.com/Edo771977/atomic-agent/pull/89).

The B4b direct ChatGPT/Copilot OAuth chain (#1578/#1579/#1707) is deferred: the candidate token store permits marked-child reads/deletes and its paths are absent from the fork protection inventories. Existing subscription CLI seats and unwired generic OAuth primitives are unchanged. [Review and reopening requirements](../reviews/b4b-subscription-signin.md).

## Local engine startup

B7a5 imports the ATO-421 TUI startup marker with prerequisite ba8bf8343. The fork retains its engine wait ceilings, avoids assigning lock ownership to a pre-lock marker, and covers a first start before the models directory exists. Error and cancellation cleanup are tested. [Review](../reviews/b7a5-start-marker.md).

## Local workers

- **Reasoning.** Local workers' reasoning is bounded by default ([#6](https://github.com/Edo771977/atomic-agent/pull/6)).
- **Self-checks.** Workers check their own work, and a failing check's output reaches the retry and the orchestrator ([#7](https://github.com/Edo771977/atomic-agent/pull/7)).
- **Briefs.** Worker briefs put the task first and size tasks for local models ([#8](https://github.com/Edo771977/atomic-agent/pull/8)).
- **The orchestrator as a target.** It can take a task itself, and a replan can split a failed task ([#9](https://github.com/Edo771977/atomic-agent/pull/9)).
- **Runtime-written changes and replies.** The runtime writes the changed lines, replies are compact while tasks are green, and a syntax pass runs before delegation ([#10](https://github.com/Edo771977/atomic-agent/pull/10)).
- **Verified delivery.** Only green tasks merge under isolation ([#11](https://github.com/Edo771977/atomic-agent/pull/11)). Verified candidate delivery has rollback, artifact evidence and measured routing ([#16](https://github.com/Edo771977/atomic-agent/pull/16), [#17](https://github.com/Edo771977/atomic-agent/pull/17), [#22](https://github.com/Edo771977/atomic-agent/pull/22), [#25](https://github.com/Edo771977/atomic-agent/pull/25)). Its recovery command is `atomic-agent fusion recover`.

## WhatsApp channel

The B5b WhatsApp Web channel (#1672) is deferred: Baileys/protobufjs add install hooks, inbound text is unframed, and auth/QR paths are outside the protected inventories. No dependency or runtime/turn-controller change is imported. [Evidence and reopening tests](../reviews/b5b-whatsapp.md).

## ACP editor protocol

The editor-launched ACP command from upstream #1646 remains deferred in B3. Its full three-commit branch was reviewed: the candidate admits marked tool children and guesses worker approval ownership from the sole busy chat. Upstream also supports persistent allow-always grants from editor replies. The fork exposes no ACP command or listener pending reliable attribution and preservation of its operator confirmation rules. [HTTP review](../../src/http/README.md)

## Local fallback consent

B7a4 defers upstream #1576 local-fallback consent. The candidate persistence owner accepts marked-child answers and the HTTP route adds no independent operator decision. No automatic question or answer file is enabled. [Evidence](../reviews/b7a4-local-last-resort.md).

## Setup and measurement

- **`atomic-agent setup fusion`.** One step from install to "cloud plans, local executes" ([#13](https://github.com/Edo771977/atomic-agent/pull/13)).
- **`atomic-agent models recommend --role worker`.** Catalog ratings of local models as Fusion workers, and a format check before the first local fan-out ([#14](https://github.com/Edo771977/atomic-agent/pull/14)).
- **`atomic-agent fusion report`.** A per-task outcome log and an end-of-turn receipt with costs and cache hits ([#12](https://github.com/Edo771977/atomic-agent/pull/12), [#31](https://github.com/Edo771977/atomic-agent/pull/31), [#32](https://github.com/Edo771977/atomic-agent/pull/32)).
- **A model server on another computer on the LAN**, without leaking the shared key ([#19](https://github.com/Edo771977/atomic-agent/pull/19)).
- **Windows.**
  - Fixes found in real Windows test runs: native Anthropic provider, verified prices and the local runtime ([#18](https://github.com/Edo771977/atomic-agent/pull/18), [#20](https://github.com/Edo771977/atomic-agent/pull/20), [#21](https://github.com/Edo771977/atomic-agent/pull/21), [#23](https://github.com/Edo771977/atomic-agent/pull/23), [#31](https://github.com/Edo771977/atomic-agent/pull/31), [#36](https://github.com/Edo771977/atomic-agent/pull/36)).
  - A Windows core CI gate.

The B4c Composio account CLI/TUI import (#1687/#1688) is deferred: connected accounts are readable from a marked child, and account selection changes the stable prompt prefix. Existing ATO-548 configuration and session pins are unchanged. [Review and reopening requirements](../reviews/b4c-composio-accounts.md).

## Hermes Python plugins

The upstream #1639 Python-to-MCP bridge remains deferred in B6a. CLI trust strings do not provide the fork's TUI confirmation, content identity or child write protection; changed plugin code executes without renewed trust. No bridge or shim is shipped. [Review and reproducible tests](../reviews/b6a-hermes-bridge.md).

## MCP over HTTP

The HTTP MCP endpoint from upstream #1705 remains deferred in B3. Its transport registry is shared across credentials and idle sessions only expire when another initialize runs. No /mcp routes or permissions are added. Import requires token ownership, bounded admission and timed stream closure, alongside the existing memory scope and skill-confirmation rules. [HTTP review](../../src/http/README.md)

## Folder constraints for confidential data

- **Per-folder rules.** `projects.constraints` lists the providers and egress classes each folder allows ([#34](https://github.com/Edo771977/atomic-agent/pull/34)). Settings: [settings reference](settings-reference.md).
- **Web URL approvals.** The ATO-1377 port checks data-bearing URLs in the guarded HTTP and web fetch paths, including redirects, and in explicit browser navigation. Literal URL arguments in MCP calls and classified shell commands are also checked. The URL check uses origin-scoped HTTP write approval alongside the browser's domain policy. [November upstream triage](upstream-2026-11-triage.md)
- **Agent proxy.** Upstream ATO-87 remains deferred. Routing through a proxy must preserve the folder's egress decision and the destination IP checks across HTTP transports. [November upstream triage](upstream-2026-11-triage.md)
- **MCP servers and "local" providers.** A stdio MCP server that uses the network needs `mcp:<server>` or `"local": true`. A "local" provider pointed at another machine needs `allowedProviderHosts` ([#63](https://github.com/Edo771977/atomic-agent/pull/63)).
- **The restriction follows the chat.** A chat keeps it when it moves, is retried or is handed off. Read taint is persisted ([#69](https://github.com/Edo771977/atomic-agent/pull/69), [#75](https://github.com/Edo771977/atomic-agent/pull/75)).
- **In the desktop.** A "restricted to: …" chip, the refusal in plain words, and the chat's own folder ([#70](https://github.com/Edo771977/atomic-agent/pull/70)).
- **What it blocks.** In a constrained folder:
  - Fusion runs on the allowed local worker only.
  - A Codex reviewer cannot be used.
  - Memory notes are labelled and kept apart.
  - No phone push is sent.

The B4a import of upstream #1671 is deferred: a marked child can read/delete a saved key and the argv guard is not a non-grantable trust decision. Secret value CLI commands and /api/secrets routes remain unavailable. [Review and reopening requirements](../reviews/b4a-1671.md).

## B7a follow-up hardening

The follow-up to #273/#274/#277 shares guarded export writes, masks presentation-equivalent keys in PDF/HTML/Word, bounds HTTP rendering and refuses tool-child CLI exports. Refusal types use eight fixed literals and params come only from structured fields. TUI startup markers are managed-only, with the existing 90-second pending/no-process ceiling pinned by a regression. [Review and validation](../reviews/b7a-followup-hardening.md).

## Provider refusal reports

B7a3 imports upstream #1727 refusal tags, with a stricter closed vocabulary for provider error codes. Structural paths cannot carry user-chosen names; offline, reporting opt-out and incognito suppress delivery as before. [Review](../reviews/b7a3-provider-refusals.md).

## Security and reliability

Organization policy (upstream #1686 / ATO-587) is imported in [fork PR #246](https://github.com/Edo771977/Atomic-Agent/pull/246) with additional fork boundaries. Invalid local files and unknown keys refuse startup; evaluator failures refuse calls. User policy, cache and the administrator's system file share the configuration/serve-key protections. Within the supported launcher flow, tool children may start without policy and intersect their own context with pinned parent local/system files and validated caches; operator policy commands remain reserved. Loaded file snapshots are identified without their contents; a child refuses if inherited bytes are missing, hidden or changed and retains stricter intermediate contexts. A fresh remote policy that cannot be cached now refuses parent startup so children cannot inherit an older, weaker snapshot; this tightens upstream's cache-write exception. Download failures retain the documented availability/cache fallback. Recursive readers, diff and structural search filter protected policy paths. Patch/Git approval metadata does not substitute for actual mutation targets. Move/trash inspect real descendants within entry/depth bounds and conservatively hold incomplete trees. Browser actions without navigation retain their ordinary profile approvals; HTTP redirects enforce both policy ask and deny. URL-data approvals remain independent for shell and resolved Git URLs. Shell analysis scopes dynamic arguments to known programs and treats opaque code/unknown client destinations conservatively. Organization Node stdin follows each command's parsed pipeline/redirection input, including nested shells and groups; output pipes and quoted metacharacters do not imply input. Known Node booleans and their negations retain file-script boundaries; unknown flags with real stdin remain conservative. Descriptor provenance tracks persistent exec redirections, multiline pipelines and owning command/process substitutions; literal syntax words do not close frames, unresolved syntax holds the call, and proven /dev/null input stays empty. Node 25 help supplies the organization option arity. Existing approval levels, folder egress, offline/privacy modes, sandbox, learned-skill confirmation, HTTP roles and private-chat visibility remain independent restrictions. See [organization policy](../../src/policy/README.md) for child/MCP administration, serialized URL semantics, read-only ask limitations, hard-link limits and direct skill-file access.

Child process environment filtering depends on the launcher. The shell builder normally filters provider credentials and supports explicit `tools.shell.envPassthrough`. A command job given a prepared environment uses that environment with the serve key removed. Browser launches using the tool-child marker also remove the serve key while retaining other inherited variables. Coverage and compatibility for a common provider-credential filter are tracked in the [triage](upstream-2026-11-triage.md).

- **Dispatch-time bypasses closed.** The shell guard, approvals, read scope and memory ([#2](https://github.com/Edo771977/atomic-agent/pull/2)).
- **Spend and lifecycle.**
  - Spend caps use the billed cost.
  - Fixes to cancellation, the sidecar and the task-retry lifecycle ([#3](https://github.com/Edo771977/atomic-agent/pull/3)).
- **Streaming.**
  - CRLF SSE streams.
  - Keep-alive versus stream reopen.
  - The fallback cooldown.
  - Unreported thinking tokens.

  See [#4](https://github.com/Edo771977/atomic-agent/pull/4).
- **Inference reliability.** External llama servers that refuse GBNF can be retried without it before any output is streamed. Fusion rejects a worker completion served without the required grammar before dispatch, even when its format probe was skipped or cached. Such completions provide no format proof. An empty native-tool answer has an abortable delay before the re-ask. Local native-tool requests reserve space for schemas independently of the cached tool catalog and share the remaining prompt budget with project context and memory.
- **Persistence.**
  - The `.env` round-trip.
  - Full forget.
  - Safe retention.
  - Atomic and durable writes.

  See [#5](https://github.com/Edo771977/atomic-agent/pull/5).
- **The sandbox keeps git's `GIT_CONFIG_*` set intact** ([#1](https://github.com/Edo771977/atomic-agent/pull/1)).
- **Desktop.**
  - The agent's bearer token travels in the environment, not on the command line.
  - Settings writes use compare-and-swap, so two windows do not overwrite each other.
  - A project decision stays "Sending…" until the agent answers.

  See [#76](https://github.com/Edo771977/atomic-agent/pull/76).

## Chat document export

B7a2 imports upstream #1715 PDF export. The TUI requires an explicit --confirm-incognito for each incognito export and --force before overwriting. The CLI and HTTP refuse incognito. All content and generated filenames mask runtime-known configuration credentials. The PDF writer uses no network or active content and adds no dependencies. [Review](../reviews/b7a2-chat-pdf.md).

## Still open

- [#33](https://github.com/Edo771977/atomic-agent/issues/33): multi-model team and an approvable assignment plan.
- [#35](https://github.com/Edo771977/atomic-agent/issues/35): the Windows test run (install, Fusion costs, folder constraints, approvals, project quality).
- [#47](https://github.com/Edo771977/atomic-agent/issues/47): the desktop line and its project card.
- [#80](https://github.com/Edo771977/atomic-agent/issues/80): the Windows acceptance checks for the rollback and milestone fixes.

## Phone calls

The B5c Twilio client (#1704) is deferred: it lacks mandatory per-call approval, offline and child credential refusal; encoded Basic authorization can escape through errors. Upstream provides no incoming-call or signature-verification slice in this commit. [Evidence and reopening tests](../reviews/b5c-twilio.md).

## OS sandbox for commands

The fork adapts upstream ATO-469 and ATO-472 with a private Linux PID namespace, protected state paths and explicit one-time shell network consent. Verification commands share the wrapper. See the [activation guide](os-sandbox.md) for supported systems and limits.

La terza revisione B1 della policy (#246) ripristina il parser delle regole personali di main e separa la classificazione prudente dell'organizzazione. Le opzioni degli interpreti terminano allo script/modulo o `--`; stdin e descrittori conservano il rifiuto prudente. Le operazioni senza file policy esistenti mantengono la parità del fork, mentre Git add/commit e pull valutano piani effettivi. Gli ask organizzativi valgono anche sui comandi sicuri. Metadati dei figli e hash sono un contratto applicativo: il file di sistema richiede autorità OS; aggiornamenti anche equivalenti di file/cache richiedono il riavvio del padre. Per limiti linguistici, script su file, hard link e sandbox/egress vedere la [guida policy](../../src/policy/README.md).

La quarta revisione B1 preserva la prudenza delle regole personali di main per opzioni di interprete ignote. La localizzazione effettiva di stdin oltre flag con valori e il rifiuto di descrittori estranei a verify restano un irrigidimento intenzionale anche senza policy. Make ordinario, inclusione POSIX, flag operativi Node e DSL sed/awk evitano falsi positivi; stream normalizzati, shell ampliate/BusyBox e selettori esterni restano prudenti. I metadati child sono indicativi, con controlli best-effort sui reset visibili, e richiedono isolamento OS per codice arbitrario. I limiti delle famiglie meno comuni sono nella [guida policy](../../src/policy/README.md#less-common-families-and-follow-up) e nel [seguito #266](https://github.com/Edo771977/Atomic-Agent/issues/266).

La quinta revisione B1 completa make eval/file-stream, distingue flag operativi e codice Node e risolve gli stream relativi dalla cwd di ogni chiamata fino ai consumatori verify/read-scope/egress. I reset visibili sono rifiutati quando rimuovono metadati presenti nel padre. L’inventario Git ora distingue i selettori davvero coperti dai programmi/configurazioni non analizzati; indirizzi/opzioni sed e alias dinamici di stdin restano limiti documentati nel seguito #266. La guida e i test elencano gli irrigidimenti personali intenzionali senza policy.
Stdio MCP sandboxing from upstream #1630 remains deferred in B6b: the client requests unrestricted network even without consent and while offline. An enabled port needs host grants enforced on the server process, folder egress and protected-path inventories. Existing MCP stdio stays outside this command wrapper. macOS already has a Seatbelt command backend with host loopback retained; Windows has no backend. No production behavior changes. [Review and reproducible tests](../reviews/b6b-mcp-sandbox.md).

La sesta revisione B1 usa selettori espliciti per il codice Node, compreso NODE_OPTIONS, e mantiene ordinari i flag lunghi operativi. Make legge gruppi corti e abbreviazioni GNU univoche; /dev/null e uno script vuoto per Make e shell. Il reset che rimuove i metadati registrati da una policy locale caricata e intenzionalmente rifiutato, con indicazioni per conservare le variabili ereditate. La guida esplicita limiti sed e differenze personali stdin.

La settima revisione B1 normalizza solo i nomi delle opzioni Node nella policy organizzativa e distingue valori separati, reporter data: e stdin ambiguo, anche tramite NODE_OPTIONS e verify. Il parser personale mantiene le proprie tabelle. I glob letterali in --allow-fs-* vanno quotati per conservare la prudenza del lexer condiviso. Make, reset dell'ambiente e /dev/null mantengono i contratti verificati.
