# Fusion project card

Status: current
Owner: src/tui/project/

The card for a fusion project's gates (issue #39): the brief, the plan and each finished milestone wait on the person here. Read [TUI instructions](../AGENTS.md) and the [project state](../../session/README.md) contract; the view the card draws is [ProjectGateView](../../session/project-gate-view.ts), built by the runtime.

## Presentation and input

[State/reducer](project-card-state.ts) holds the view, the mode (`actions`, `edit` rows, `note`), pending picks and the scroll; [lines](project-card-lines.ts) turn it into text (pure, tested without a terminal); [the popup](project-card-popup.tsx) paints them centred in the content pane like the other popups, keeping the buttons visible while the body scrolls (PgUp/PgDn). Compact or full follows `view.detail`; `/plan` forces full.

Buttons come from `view.allowedVerdicts`, never a fixed list: `a` approve, `e` edit rows (plan gate: per row, ←/→ picks a worker or reviewer among the row's `selectable` members, tab switches field, enter sends), correct (milestone gate: the person types a note) or revise (brief gate: the person writes the change in the composer), `c` cheaper, `q` quality, `x` cancel. Esc steps back or puts the card away; `/plan` reopens it. [Keys](project-card-keys.ts) are modal while the card is up on its own chat, below a pending approval, and leave Ctrl+C to the app.

A brief drafted after untrusted content carries a warning; approval still comes only from the person. Violations from the live estimates are listed, hard ones marked; the runtime refuses approve while one stands.

## Operations

`ChatOrchestrator.decideProject` sends the verdict through `AgentRuntime.projectDecision` between turns only, then shows the view the runtime answers with (an edit's re-estimate is the runtime's). When the decision closed the gate and the director has work, [projectContinueMessage](../../session/project-continue.ts) is sent as the person's next turn. `project_gate` events of the chat on screen replace the view; another chat's wait until it is opened. Opening a chat prints `Project — last done: X · next: Y`, offers `/fusion resume` for a milestone cut off mid-run, and raises the open gate's card.

## Checks

`COLORTERM=truecolor npx vitest run src/tui/project src/tui/menu src/tui/commands`, then `npm run lint` and `npm run docs:check`.
