# Fusion project card

Status: current
Owner: src/tui/project/

The card for a fusion project's gates (issue #39): the brief, the plan and each finished milestone wait on the person here. Read [TUI instructions](../AGENTS.md) and the [project state](../../session/README.md) contract; the view the card draws is [ProjectGateView](../../session/project-gate-view.ts), built by the runtime.

## Presentation and input

[State/reducer](project-card-state.ts) holds the view, the mode (`actions`, `edit` rows, `note`), pending picks and the scroll; [lines](project-card-lines.ts) turn it into text (pure, tested without a terminal); [the popup](project-card-popup.tsx) paints them centred in the content pane like the other popups, keeping the buttons visible while the body scrolls (PgUp/PgDn). Compact or full follows `view.plan.detail`; `/plan` forces full. A milestone's evidence (issue #40) shows under its summary: each criterion fact (`✓` passed, `✕` failed, `?` unverified, with its why) and each picture's caption with its path as an OSC 8 file link; the card never opens or renders the image.

The milestone awaiting review shows an `Evidence` line when receipt status is available. It counts valid signatures, unsigned receipts and verification problems. Unsigned receipts have no verifiable signature. The signing key may have been unavailable, for example when the OS keychain was closed or missing. For unsigned receipts, problems or a partial scan, the card points to `atomic-agent project verify` with the project folder. Incognito has no receipt summary. Signatures support retrospective verification. A process running as the same user with access to the keychain can sign replacement evidence.

Buttons come from `view.allowedVerdicts`, never a fixed list (issue #98 adds `o` approve over review, offered only while the milestone has open review blocks: the person types the reason and Enter sends `approveOverReview` with it; the desktop card will follow): `a` approve, `e` edit rows (hidden when `view.plan.editable` is false, issue #54; the card shows `view.hints` under the violations; plan gate: per row, ←/→ picks a worker or reviewer among the row's `selectableWorkers` / `selectableReviewers`, tab switches field, enter sends), correct (milestone gate: the person types a note, sent as `edits.note`) or revise (brief gate: the person writes the change in the composer), `c` cheaper, `q` quality, `d` (issue #112, plan gate only): `defer <ids>` while active decisions of the brief are cited by no task, sending `edit` with `edits.decisionStatus` deferring those; with none left, `reactivate <ids>` sets the deferred and informational ones back to active; the card lists the decisions with status and citing tasks, `x` cancel. Esc steps back or puts the card away; `/plan` reopens it. [Keys](project-card-keys.ts) are modal while the card is up on its own chat, below a pending approval, and leave Ctrl+C to the app.

At the plan gate the card says the approved write scope is the chat's folder (plan rows carry no file list; a write outside it still asks), as the CLI and Telegram text do (`PROJECT_WRITE_SCOPE_NOTE`). A brief drafted after untrusted content carries a warning; approval still comes only from the person. Violations from the live estimates are listed, hard ones marked; the runtime refuses approve while one stands. With a backlog (issue #111, `view.backlog`) the card says `Backlog: N open · M seeds · K promoted`, lists each seed with its condition at a plan or milestone gate, at the plan gate lists each promoted item with the tasks citing it (`cited by no task`, warned, or `deferred`; issue #146), and the resume line adds the open count.

Press `b` to browse the backlog and `↑`/`↓` to select an item. `p` promotes, `d` drops and `r` reopens it. A changed item shows the old decision as stale. A removed item offers `r` to clear the old decision. The selection follows the item ID across refreshes. The runtime returns the updated project or a refusal through the card; backlog decisions do not start a director turn.

## Operations

`ChatOrchestrator.decideProject` sends the verdict through `AgentRuntime.projectDecision` between turns only, then shows the view the runtime answers with (an edit's re-estimate is the runtime's) and takes the returned `project` into the chat's own session copy, which runs and saves the next turn, so that save never puts the old gate back (the CLI's `run` loop does the same). When the decision closed the gate and the director has work, [projectContinueMessage](../../session/project-continue.ts) is sent as the person's next turn. `project_gate` events of the chat on screen replace the view; another chat's wait until it is opened. Opening a chat prints `Project — last done: X · next: Y`, offers `/fusion resume` for a milestone cut off mid-run, and raises the open gate's card.

## Checks

`COLORTERM=truecolor npx vitest run src/tui/project src/tui/menu src/tui/commands`, then `npm run lint` and `npm run docs:check`.
