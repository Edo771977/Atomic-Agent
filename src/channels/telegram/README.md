# Telegram adapter

Status: current
Owner: src/channels/telegram/

The paired owner can use project commands in their current Telegram chat. `/plan` shows the gate waiting for approval, and `/backlog` lists items by ID and status, with seed conditions, plan adoption and stale decisions.

Use `/promote b1`, `/drop b1` or `/reopen b1` to preview a change. Repeat the command with the code displayed in the preview, such as `/promote b1 <code>`. If the item's content or status changes, request a fresh preview. These decisions are available between turns, even when no gate is open. A promoted item is a proposal for the next plan, which still needs approval.

For setup and routing, see the [adapter guide](../docs/adapters.md). For the project workflow, see [Fusion projects](../../../docs/user/fusion-projects.md).
