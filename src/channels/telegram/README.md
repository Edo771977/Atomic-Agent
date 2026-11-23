# Telegram adapter

Status: current
Owner: src/channels/telegram/

The paired owner can use project commands in their current Telegram chat. `/plan` shows the gate waiting for approval, and `/backlog` lists items by ID and status, with seed conditions, plan adoption and stale decisions.

Use `/promote b1`, `/drop b1` or `/reopen b1` to preview a change. Repeat the command with the code displayed in the preview, such as `/promote b1 <code>`. If the item's content or status changes, request a fresh preview. These decisions are available between turns, even when no gate is open. A promoted item is a proposal for the next plan, which still needs approval.

While a plan is waiting for approval, use `/defer b1` or `/activate b1` for a promoted item still waiting to be taken into a plan. Repeat the command with the displayed code to confirm against the plan version and item you saw. Deferring keeps the item promoted and makes it optional for the plan. Activating makes plan coverage required again. If the view changes, ask for a new preview. For decisions from the brief, use `/defer <id>` and `/reactivate <id>` with the plan version shown in the preview.

Send `/lessons` to list the current project's lessons, their declared and effective status, whether they are binding, the paths they cover, and any skipped files. Use `/lesson_approve <id>`, `/lesson_retire <id>` or `/lesson_reopen <id>` to see the lesson, excerpts and its fingerprint. Repeat the command with the displayed confirmation code. Only lessons declared `active` can be approved. If the file changes, request a fresh preview. These commands require a regular project chat, and choices can only be made between turns.

At the plan gate, use `/lesson_defer <id>` to set a binding lesson aside for the current plan or `/lesson_activate <id>` to require it again. Repeat with the displayed code to confirm against the plan version you previewed. Use `/plan` to see the binding lessons and review the updated plan.

The milestone notice and `/plan` show the director report, any unsupported-claim warnings, and criterion facts with their basis and counts. Previously saved facts without a basis display “basis not recorded”.

For setup and routing, see the [adapter guide](../docs/adapters.md). For the project workflow, see [Fusion projects](../../../docs/user/fusion-projects.md).
