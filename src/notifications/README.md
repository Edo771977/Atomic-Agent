# Out-of-band notifications

Status: current
Owner: src/notifications/

Plain-text pings to the operator outside a chat turn. Read the root instruction route and the underlying domain instructions (channels, approval) before cross-domain changes.

## Entry points

- [download-notifier.ts](download-notifier.ts): sends configured completion notices from detached download workers. Uses recorded job outcomes, configured destinations and scrubbed errors; one REST call, no channel loop.
- [approval-pending-notifier.ts](approval-pending-notifier.ts): `notifications.approvalPending` (off by default). The runtime installs it as the approval gate's pending observer, so it sees exactly the prompts a person is asked, Fusion orchestrator approvals (merge gate, contract checks, candidate finish, `verify.run`) included. A prompt still unanswered after `afterMinutes` (default 5) gets one message, through `sendOwnerNotice` of a Telegram or Discord channel already up in this process (`channel`: `auto` tries Telegram, then Discord): "atomic-agent is waiting for your approval for N min: <category> (<tool>) in <folder>. Answer it in the app." (an `ask_user` question says "waiting for your answer"). It never carries the preview, arguments, resources or reason; an incognito chat (or any while one is open) gets the line without category, tool or folder. Answering, a session-wide denial or an aborted turn cancels the timer; offline mode, no running channel or a channel with no paired owner sends nothing (a debug log). It is a reminder only: approving from the chat exists just for sessions a channel owns, through the [approval router](../approval/approval-router.ts), and those sessions get no reminder (`isRouted`: the prompt is already in the owner's DM). At most one reminder goes out a minute; prompts due inside that minute go out at its end as one "atomic-agent: N approvals are waiting for you. Answer them in the app." (one still waiting: its own message).

Checks: `npx vitest run src/notifications`; `npm run lint`; `npm run docs:check`.
