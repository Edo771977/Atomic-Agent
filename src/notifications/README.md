# Notifications

Status: current
Owner: src/notifications/

Out-of-band pings to the operator outside a chat turn: a detached download worker reporting that a model landed, phone push through ntfy (ATO-1129), and a reminder of an approval left waiting. Use recorded job outcomes, configured destinations and scrubbed errors.

Entry points:

- [download-notifier.ts](download-notifier.ts): one message on the channel a background download was armed with (`telegram`, `discord`, `email`, `push`).
- [ntfy-client.ts](ntfy-client.ts): `sendPush`, one JSON POST to `notifications.push.server` for `notifications.push.topic`, one attempt with an 8 s timeout, never throws. Title and body go through `maskSecrets` (the agent's `.env` values as known secrets) and are clipped to 200 characters. `generatePushTopic` mints the random topic: on ntfy.sh a topic is public by name. An optional access token is read from the env var named by `tokenEnv` (default `NTFY_TOKEN`).
- [approval-pending-notifier.ts](approval-pending-notifier.ts): `notifications.approvalPending` (off by default). The runtime installs it as the approval gate's pending observer, so it sees exactly the prompts a person is asked, Fusion orchestrator approvals (merge gate, contract checks, candidate finish, `verify.run`) included. A prompt still unanswered after `afterMinutes` (default 5) gets one message, through `sendOwnerNotice` of a Telegram or Discord channel already up in this process (`channel`: `auto` tries Telegram, then Discord): "atomic-agent is waiting for your approval for N min: <category> (<tool>) in <folder>. Answer it in the app." (an `ask_user` question says "waiting for your answer"). It never carries the preview, arguments, resources or reason; an incognito chat (or any while one is open) gets the line without category, tool or folder. Answering, a session-wide denial or an aborted turn cancels the timer; offline mode, no running channel or a channel with no paired owner sends nothing (a debug log). It is a reminder only: approving from the chat exists just for sessions a channel owns, through the [approval router](../approval/approval-router.ts), and those sessions get no reminder (`isRouted`: the prompt is already in the owner's DM). At most one reminder goes out a minute; prompts due inside that minute go out at its end as one "atomic-agent: N approvals are waiting for you. Answer them in the app." (one still waiting: its own message).
- [push-messages.ts](push-messages.ts): the words of each push (turn end, approval waiting, task report, download). Only the agent's answer, never tool output or an approval preview.
- [push-setup.ts](push-setup.ts): `push on` / `off` persistence, shared by `atomic-agent push` and the TUI download prompt.
- [push-task-report.ts](push-task-report.ts): the task report sink for `notify: "push"`; `src/runtime/composition/runtime-task-services.ts` routes per `TaskReport.notify`.

Not here yet: a tap-to-open link in the push (needs a reachable `atag serve` URL), and the desktop app's own push (`desktop/main/turn-notify.ts`).

Read the root instruction route and the underlying domain instructions (channels, approval) before cross-domain changes.

Checks: `npx vitest run src/notifications`; `npm run lint`; `npm run docs:check`.
