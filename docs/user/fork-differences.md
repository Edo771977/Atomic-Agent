# How this fork differs from upstream

Status: current
Owner: docs/user/

This fork (Edo771977/atomic-agent) starts from [AtomicBot-ai/atomic-agent](https://github.com/AtomicBot-ai/atomic-agent).

## Last sync with upstream

The fork was last brought in step with upstream on 17 November 2026:

- `main`: [#57](https://github.com/Edo771977/atomic-agent/pull/57), a one-time merge of upstream `main`, tracked in [#56](https://github.com/Edo771977/atomic-agent/issues/56).
- The desktop line: [#61](https://github.com/Edo771977/atomic-agent/pull/61), upstream `desktop-v0.0.9` merged into `desktop-main`, tracked in [#59](https://github.com/Edo771977/atomic-agent/issues/59).

Earlier upstream PRs came in as batches:

- [#24](https://github.com/Edo771977/atomic-agent/pull/24): 14 upstream PRs (Fusion, local models, approvals, costs, router).
- [#26](https://github.com/Edo771977/atomic-agent/pull/26): batch 2 (local models, pricing snapshot, memory, `/resume`).
- [#27](https://github.com/Edo771977/atomic-agent/pull/27): batch 3 (agent fixes, engine wait, reasoning level, memory flush, superseded notes).
- [#28](https://github.com/Edo771977/atomic-agent/pull/28): batch 4 (offline mode, incognito chats, chat ops, provider presets).
- [#41](https://github.com/Edo771977/atomic-agent/pull/41): batch 5 (`browser.debug`, `ask_user`, LSP diagnostics, skill bins, settings reference, per-turn model).

Anything upstream published after 17 November is not here until it is imported.

The official installer (`curl … atomicagent.io/install`) and upstream's release packages install upstream's code, without any of the changes below. To use this fork:

- Build it from source with `npm ci && npm run build && npm link`.
- For the desktop app, use the `desktop-<platform>` artifact of the fork's **Desktop packages** workflow on `desktop-main`.

Everything below exists only in this fork. Links are to the fork's pull requests.

## Fusion team

- **Roles.** Director, worker and reviewer, with the director chosen per session ([#42](https://github.com/Edo771977/atomic-agent/pull/42)).
- **A reviewer per task.**
  - It gives a structured verdict and has at most two passes; then the director decides ([#44](https://github.com/Edo771977/atomic-agent/pull/44)).
  - A periodic watch checks that a running worker is progressing and not stuck ([#45](https://github.com/Edo771977/atomic-agent/pull/45)).
- **A chat chooses its reviewer, or none.** An OpenAI Codex (ChatGPT) subscription can be the reviewer, read-only. Adding the first reviewer does not turn review on for every chat ([#72](https://github.com/Edo771977/atomic-agent/pull/72); desktop seats in [#73](https://github.com/Edo771977/atomic-agent/pull/73)).

## Fusion projects with gates

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

## Local workers

- **Reasoning.** Local workers' reasoning is bounded by default ([#6](https://github.com/Edo771977/atomic-agent/pull/6)).
- **Self-checks.** Workers check their own work, and a failing check's output reaches the retry and the orchestrator ([#7](https://github.com/Edo771977/atomic-agent/pull/7)).
- **Briefs.** Worker briefs put the task first and size tasks for local models ([#8](https://github.com/Edo771977/atomic-agent/pull/8)).
- **The orchestrator as a target.** It can take a task itself, and a replan can split a failed task ([#9](https://github.com/Edo771977/atomic-agent/pull/9)).
- **Runtime-written changes and replies.** The runtime writes the changed lines, replies are compact while tasks are green, and a syntax pass runs before delegation ([#10](https://github.com/Edo771977/atomic-agent/pull/10)).
- **Verified delivery.** Only green tasks merge under isolation ([#11](https://github.com/Edo771977/atomic-agent/pull/11)). Verified candidate delivery has rollback, artifact evidence and measured routing ([#16](https://github.com/Edo771977/atomic-agent/pull/16), [#17](https://github.com/Edo771977/atomic-agent/pull/17), [#22](https://github.com/Edo771977/atomic-agent/pull/22), [#25](https://github.com/Edo771977/atomic-agent/pull/25)). Its recovery command is `atomic-agent fusion recover`.

## Setup and measurement

- **`atomic-agent setup fusion`.** One step from install to "cloud plans, local executes" ([#13](https://github.com/Edo771977/atomic-agent/pull/13)).
- **`atomic-agent models recommend --role worker`.** Catalog ratings of local models as Fusion workers, and a format check before the first local fan-out ([#14](https://github.com/Edo771977/atomic-agent/pull/14)).
- **`atomic-agent fusion report`.** A per-task outcome log and an end-of-turn receipt with costs and cache hits ([#12](https://github.com/Edo771977/atomic-agent/pull/12), [#31](https://github.com/Edo771977/atomic-agent/pull/31), [#32](https://github.com/Edo771977/atomic-agent/pull/32)).
- **A model server on another computer on the LAN**, without leaking the shared key ([#19](https://github.com/Edo771977/atomic-agent/pull/19)).
- **Windows.**
  - Fixes found in real Windows test runs: native Anthropic provider, verified prices and the local runtime ([#18](https://github.com/Edo771977/atomic-agent/pull/18), [#20](https://github.com/Edo771977/atomic-agent/pull/20), [#21](https://github.com/Edo771977/atomic-agent/pull/21), [#23](https://github.com/Edo771977/atomic-agent/pull/23), [#31](https://github.com/Edo771977/atomic-agent/pull/31), [#36](https://github.com/Edo771977/atomic-agent/pull/36)).
  - A Windows core CI gate.

## Folder constraints for confidential data

- **Per-folder rules.** `projects.constraints` lists the providers and egress classes each folder allows ([#34](https://github.com/Edo771977/atomic-agent/pull/34)). Settings: [settings reference](settings-reference.md).
- **MCP servers and "local" providers.** A stdio MCP server that uses the network needs `mcp:<server>` or `"local": true`. A "local" provider pointed at another machine needs `allowedProviderHosts` ([#63](https://github.com/Edo771977/atomic-agent/pull/63)).
- **The restriction follows the chat.** A chat keeps it when it moves, is retried or is handed off. Read taint is persisted ([#69](https://github.com/Edo771977/atomic-agent/pull/69), [#75](https://github.com/Edo771977/atomic-agent/pull/75)).
- **In the desktop.** A "restricted to: …" chip, the refusal in plain words, and the chat's own folder ([#70](https://github.com/Edo771977/atomic-agent/pull/70)).
- **What it blocks.** In a constrained folder:
  - Fusion runs on the allowed local worker only.
  - A Codex reviewer cannot be used.
  - Memory notes are labelled and kept apart.
  - No phone push is sent.

## Security and reliability

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

## Still open

- [#33](https://github.com/Edo771977/atomic-agent/issues/33): multi-model team and an approvable assignment plan.
- [#35](https://github.com/Edo771977/atomic-agent/issues/35): the Windows test run (install, Fusion costs, folder constraints, approvals, project quality).
- [#47](https://github.com/Edo771977/atomic-agent/issues/47): the desktop line and its project card.
