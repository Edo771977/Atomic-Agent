# Fusion projects

Status: current
Owner: src/session/

A Fusion project takes a task from brief to plan to delivery. You approve the brief, the plan and each milestone result at a gate. Read the gate before deciding. It shows what changed, which checks matter and what will happen next.

Fusion can use Draft, Review and Final milestones for non-code work, and task review follows the delivery type in your approved brief.

## Find or resume a project

In the desktop sidebar, open **Fusion projects** under **Projects**. The list groups projects by **Needs you**, **Problem**, **In progress**, **Idle** and **Done**. Select **Resume** to open the project's newest chat or start one if needed.

From a terminal:

~~~sh
atomic-agent projects list
atomic-agent project resume ./my-project
atomic-agent projects forget ./my-project
~~~

Use `forget` to remove a folder from the list. It keeps the files and the project's saved decisions.

## What travels with the folder

Open `.atomic/project/BRIEF.md`, `PLAN.md` or `STATUS.md` for a readable snapshot. Atomic Agent generates these files from the project. It reads editable brief, plan and milestone content from `.atomic/project/project.json`.

Approvals, decision status, milestone progress and evidence are kept in the Atomic Agent data directory. Editing the saved brief or plan outside Atomic Agent reopens the affected gate for your approval. Copying the folder gives you the project content with fresh gates and no carried approvals. Deleting a chat leaves its folder's project available to resume.

## Approve project lessons

Save lessons as Markdown files in `.atomic/project/lessons/` so they travel with the project folder. To see the lessons, their effective status and any stale choices, run `atomic-agent project lessons ./my-project`. Omit the folder to use the current directory, or add `--json` for structured output.

Open the project in a regular chat. Between turns, use these commands from your terminal.

~~~sh
atomic-agent project lessons ./my-project --approve local-storage
atomic-agent project lessons ./my-project --retire local-storage
atomic-agent project lessons ./my-project --reopen local-storage
~~~

Set `status: active` in the file before you approve it. When you edit the file, review the updated content and approve it again. Your choice is saved in the Atomic Agent data directory for this folder.

The director and plan reviewer use active lessons when drafting and reviewing the plan. A worker sees only lessons relevant to its declared files and check paths. Mark an active lesson `always: true` to flag a binding choice for planning and review. Folder provider restrictions also apply to lessons, and chats bound to restricted projects keep their conversation out of personal memory. See the [lesson file format](../../src/session/README.md#project-lesson-files).

## Read the plan checks

A plan can list checks for each task before work starts. Check that the tasks cover the brief's success criteria and that their tests measure the behavior you asked for. If the checks need to change, ask the director to update the plan and approve the revised version.

- A clearly ineffective check can block the plan. For example, a command that prints `passed` and then checks for that same word proves little. An assertion that would also match `0 passed` can trigger a warning.
- A **negative control** runs the same check with input that should fail. For a CSV validator, try a file with a required column missing. If the negative input passes, the check is unreliable and its criterion remains unverified. If the control could not run, an otherwise passing result may read **verified with reservations**.
- A **references** warning may identify a missing file, package script or code symbol the plan expects to find. Ask the director to fix the reference or say that the task will create it. A references warning alone allows approval.

## Keep decisions visible

The director can propose decisions in the brief, such as “Use SQLite for local storage.” Approving the brief adopts those decisions. The plan must cite each active decision in work that will run. An uncited active decision blocks approval and the gate names it.

Ask the director to add the missing citation. If the decision can wait, defer it explicitly from the plan gate. In the terminal UI project card, press `d` to defer uncited decisions. Review and approve the updated plan. Decision status is saved with your approvals.

## Decide on backlog items

Open `/plan` in the TUI and press **b** for the backlog, including between gates. Select an item with **↑/↓**, then press **p** to promote it for planning, **d** to drop it, or **r** to reopen it. The card reports the result. A running turn must finish before the project accepts a decision.

A warning marks an item whose text changed after your decision. Review its current text before deciding again. For an item removed outside Atomic Agent, **r** clears the old decision. **Esc** returns to the project card.

## Review the backlog in Telegram

In your paired Telegram chat, send `/backlog` to see open, promoted and dropped items, seed conditions, the plan version that took in a promoted item, and stale decisions reported by the project.

- `/promote <id>` previews proposing the item for the next plan. You still approve that plan separately.
- `/drop <id>` previews marking the item as dropped.
- `/reopen <id>` previews taking back the recorded decision.
- At the plan gate, `/defer <id>` makes a promoted item optional for this plan. `/activate <id>` makes plan coverage required again. Both commands preview the change and confirm against the displayed item and plan version.

Confirm by repeating the command with the code shown in the preview, for example `/promote b1 <code>`. If the item or its decision status changed, ask for a fresh preview. You can promote, drop or reopen items between turns, including when the project has no gate waiting. A seed's condition is a reminder for you to review the item.

Clients using HTTP or the sidecar can tie a decision to the item shown on screen by sending the displayed `fingerprint` as `expectedFingerprint`. If the item or its recorded decision has changed, the client receives `stale-view` and the current view so it can ask you to review the item again.

## Take promoted backlog items into the plan

The backlog holds work that is not ready for the plan yet. Only you promote, drop or reopen an item (`atomic-agent project backlog --promote <id>`, or the project card). A promoted item is for the next plan: the director cites its id on a task that will run, and the plan gate checks this (**backlog-coverage**). A plan that cites no task for a promoted item cannot be approved, and the gate names the missing item. A citation added to a task of a milestone that already started does not count. If a later plan drops the citation before that work runs, the item is required again.

If the item can wait, defer it from the plan gate. It stays promoted, the plan no longer has to take it in, and your choice is saved with your approvals; set it active again to require it. Only the plan you approve takes an item in: `atomic-agent project backlog` shows each one as "promoted, not in any plan", "promoted, deferred at the plan gate, not in any plan" or "promoted, taken in by plan vN". An item you promote while a plan is already running waits for the next plan draft. The gate and `PLAN.md` show which tasks cite each item, and the worker of such a task is given the item's text. When every milestone is reviewed, the project says which promoted items were never done.

## Read the plan review

When the Fusion team has a plan reviewer or a reviewer it can use for the plan, a model reads the draft against the approved brief. It looks at coverage, dependencies, scope, estimates and other risks. A failed review can send the draft back to the director for up to two revisions by default. Remaining notes appear at the gate.

- **Plan not reviewed** means you should check the plan yourself. A skipped or unavailable review can leave the plan in this state.
- **Notes on an earlier version** means the rows or milestone order changed after the review, or you changed a decision's status or deferred a backlog item at the gate. Those notes no longer block your plain approval; read them alongside the current plan. Automatic approval still stops there.
- **Approve over review** is available when the current review blocks approval and the gate allows an override. Write why you are proceeding. The reason is saved with the approval. Failed plan checks still block approval.

For a CLI run, `--auto-approve-project` approves eligible gates as they open. It stops for open plan review failures, or when a required review is missing, skipped or stale. It also stops for changes made outside Atomic Agent, failed plan checks and milestone results that need your decision. Review the gate and the version it prints. To approve an eligible version yourself, use:

~~~sh
atomic-agent run --session <session-id> --approve <version>
~~~

## Check documents and spreadsheets

Not every deliverable is code. A check can read a local document or spreadsheet without running anything:

- **Documents** (`.docx`, `.md`, `.pdf`, `.txt`): required section headings, a word range, leftover placeholders such as `TODO`, `lorem ipsum` or `[insert]`, and the expected language. When the language cannot be told from the text, the result is **uncheckable**, never a pass.
- **Spreadsheets** (`.xlsx`, `.csv`): required sheets and columns, cells with errors such as `#REF!` or `#DIV/0!` (named by sheet and cell), and totals recalculated from the data within a stated tolerance.

Macros and formulas are never run; workbook formulas need their saved results. Files over the size or time limits are reported as uncheckable with the reason. For the exact fields, see the [verification guide](../../src/tools/verify/README.md).

## Check UI source files

For a UI or polish milestone, the director can pair visual review with an Impeccable source check. Add a plan check such as `{ kind: "ui", path: "src/index.html", criteria: ["contrast"] }`, using the ID of an approved criterion. The check uses the locally installed CLI and reports the version, rule and file for each finding, and any inline suppression markers. A severe finding fails the linked criterion. A missing detector or a scan that cannot prove it covered a file is reported as `uncheckable`. [UI check options and verdicts](../../src/tools/verify/README.md#ui-source-checks)

## Verify signed receipts

~~~sh
atomic-agent project verify ./my-project
~~~

This command checks saved delivery, check-execution, gate-decision and milestone-report receipts. Use `atomic-agent project verify ./my-project --json` for machine-readable results. A valid signature confirms the saved receipt matches what was signed. A receipt changed outside the app can report a hash or signature mismatch. Receipts may be unsigned when the signing key is unavailable.

Verification covers the receipts present. It cannot tell whether a receipt was removed or whether current project files match the old delivery. A process running as your user with access to the signing key can sign replacement receipts.

For implementation details, see the [session storage guide](../../src/session/README.md), the [Fusion module guide](../../src/tools/fusion/README.md) and the [CLI reference](../../src/cli/README.md).
