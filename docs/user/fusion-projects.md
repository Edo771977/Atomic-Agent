# Fusion projects

Status: current
Owner: src/session/

A Fusion project takes a task from brief to plan to delivery. You approve the brief, the plan and each milestone result at a gate. Read the gate before deciding. It shows what changed, which checks matter and what will happen next.

Fusion can use Draft, Review and Final milestones for non-code work, and task review follows the delivery type in your approved brief.

The milestone report shows the status and basis of each reported criterion, plus counts by basis. **Measured** means a check ran. **Judged by** names the model that assessed the screenshot. **Basis not recorded** covers earlier facts and cases where no source produced evidence. Approving over a review records your decision about the milestone.

The director report and runtime notes appear separately. Each sentence is checked for affirmative forms of “verified”, “tested”, “works”, “working”, “passes”, “verificato” (including gender and plural forms), “funziona”, “funzionano” and “funzionante”. The check skips simple negations such as “not verified” and “non funziona”. A claim needs the full text or exact ID (with or without brackets) of a passed criterion in the same sentence. The check uses the approved criteria when available and the brief otherwise. The warning does not change criterion status or approval.

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
atomic-agent project lessons ./my-project --approve local-storage@0123456789ab
atomic-agent project lessons ./my-project --retire local-storage
atomic-agent project lessons ./my-project --reopen local-storage
~~~

Replace the example fingerprint with the one displayed for the lesson. Set `status: active` in the file before you approve it. When you edit the file, review the updated content and approve it again. Your choice is saved in the Atomic Agent data directory for this folder.

The director and plan reviewer use active lessons when drafting and reviewing the plan. A worker sees only lessons relevant to its declared files and check paths. Mark an active lesson `always: true` to make it binding. Every task whose declared files or checks match its `touches` must cite the lesson. A binding lesson with omitted or empty `touches`, or with `touches: ["."]`, applies to every task in a milestone that has yet to start. Existing approvals of unchanged `always: true` lessons with `touches: []` also apply to every such task. The existing approval remains valid because it covers the same file fingerprint. You can defer the lesson at the plan gate to set it aside for the current plan. Missing citations block approval, and assigned workers receive the cited lessons as binding project data. Folder provider restrictions also apply to lessons, and turns that share lessons from a restricted project keep personal memory read-only. See the [lesson file format](../../src/session/README.md#project-lesson-files).

### Lessons proposed by the director

The director can propose a reusable lesson after a correction, a failed milestone or the final review. Find the proposal and its origin with `atomic-agent project lessons`. After reviewing the Markdown, change `status: proposed` to `status: active`, list the lessons again and approve the new fingerprint.

When a milestone is reported done, its runtime notes list known changed files covered by active lessons. Use these reminders during review to check that the changes follow the lessons.

## Read the plan checks

A plan can list checks for each task before work starts. Check that the tasks cover the brief's success criteria and that their tests measure the behavior you asked for. If the checks need to change, ask the director to update the plan and approve the revised version.

- A clearly ineffective check can block the plan. For example, a command that prints `passed` and then checks for that same word proves little. An assertion that would also match `0 passed` can trigger a warning.
- A **negative control** runs the same check with input that should fail. For a CSV validator, try a file with a required column missing. If the negative input passes, the check is unreliable and its criterion remains unverified. If the control could not run, an otherwise passing result may read **verified with reservations**.
- A UI check records the Impeccable version and whether it scanned a file or a rendered page. A criterion can pass **with reservations** when only checks with warnings or other reservations support it. The criterion shows the warning count and the rule and shortened reason for any operator exception used by the UI check. Milestone summaries show a separate count, such as “5 measured, 1 measured with reservations”.
- A **references** warning may identify a missing file, package script or code symbol the plan expects to find. Ask the director to fix the reference or say that the task will create it. A references warning alone allows approval.

## Defer a binding lesson for a plan

The plan card lists each binding lesson and the tasks that cite it. Press **l** to defer uncovered lessons or **r** to reactivate deferred lessons. In the CLI, target a lesson by ID.

```sh
atomic-agent run --session <session-id> --defer-lesson <lesson-id>
atomic-agent run --session <session-id> --activate-lesson <lesson-id>
```

The choice stays with the current plan and is saved with your approvals. The plan version changes and the earlier review becomes stale. Review the updated plan before approving it.

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

Use the plan card in the TUI or Desktop, Telegram's `/defer` and `/activate`, or send a versioned plan-gate `edit` with `edits.backlogStatus` over HTTP. In the CLI, use one of these commands at the plan gate:

```sh
atomic-agent run --session <session-id> --defer-backlog b1,b2
atomic-agent run --session <session-id> --activate-backlog b1
```

The command prints the updated plan and exits 3 while it waits for approval. Review the updated plan, then run `atomic-agent run --session <session-id> --approve <version>` separately with the version shown. Run `atomic-agent project backlog [folder]` to list the items and their current status.

## Read the plan review

When the Fusion team has a plan reviewer or a reviewer it can use for the plan, a model reads the draft against the approved brief. It looks at coverage, dependencies, scope, estimates and other risks. A failed review can send the draft back to the director for up to two revisions by default. Remaining notes appear at the gate.

- **Plan not reviewed** means you should check the plan yourself. A skipped or unavailable review can leave the plan in this state.
- **Notes on an earlier version** means the rows or milestone order changed after the review, or you changed the status of a decision, binding lesson or backlog item at the gate. Those notes no longer block your plain approval; read them alongside the current plan. Automatic approval still stops there.
- **Approve over review** is available when the current review blocks approval and the gate allows an override. Write why you are proceeding. The reason is saved with the approval. Failed plan checks still block approval.

For a CLI run, `--auto-approve-project` approves eligible gates as they open. It stops for open plan review failures, or when a required review is missing, skipped or stale. It also stops for changes made outside Atomic Agent, failed plan checks and milestone results that need your decision. Review the gate and the version it prints. To approve an eligible version yourself, use:

~~~sh
atomic-agent run --session <session-id> --approve <version>
~~~

## Check documents and spreadsheets

Not every deliverable is code. A check can verify local documents, spreadsheets, file deliveries and research:

- **Documents** (`.docx`, `.md`, `.pdf`, `.txt`): required section headings, a word range, leftover placeholders such as `TODO`, `lorem ipsum` or `[insert]`, and the expected language. When the language cannot be told from the text, the result is **uncheckable**, never a pass.
- **Spreadsheets** (`.xlsx`, `.csv`): required sheets and columns, cells with errors such as `#REF!` or `#DIV/0!` (named by sheet and cell), and totals recalculated from the data within a stated tolerance.

- **Files**: expected names and paths, optional entry types, and containment of known changes inside a delivery folder. Without a change list, containment is uncheckable.
- **Research**: numbered citations, matching sources and source dates. URLs are verified only with permitted HTTP egress and explicit approval. In a restricted or offline folder, URLs are shown as unverified and cannot pass a linked criterion.

Macros and formulas are never run; workbook formulas need their saved results. Files over the size or time limits are reported as uncheckable with the reason. For the exact fields, see the [verification guide](../../src/tools/verify/README.md).

## Check UI source files

For a UI or polish milestone, the director can pair visual review with an Impeccable source check. Add a plan check such as `{ kind: "ui", path: "src/index.html", criteria: ["contrast"] }`, using the ID of an approved criterion. The check uses the locally installed CLI and reports the version, rule and file for each finding, and any inline suppression markers. A severe finding fails the linked criterion. A missing detector or a scan that cannot prove it covered a file is reported as `uncheckable`. [UI check options and verdicts](../../src/tools/verify/README.md#ui-source-checks)

Use `url: "http://localhost:4173/"` in place of `path` to check the rendered page with an installed browser. A Fusion check can also reference a named service in the same batch. The page may load external assets, so rendered checks are subject to the folder's browser egress policy. [Rendered check options](../../src/tools/verify/README.md#ui-source-checks)

If a finding is intentional, record your reason between turns from a terminal. This exception applies to one file. Omit `:src/index.html` for an exception across the project, including rendered scans.

~~~sh
atomic-agent project ui-exceptions ./my-project --allow low-contrast:src/index.html --reason "Decorative wordmark"
atomic-agent project ui-exceptions ./my-project --json
atomic-agent project ui-exceptions ./my-project --revoke low-contrast:src/index.html
~~~

The project record in your Atomic Agent data directory keeps the approval. A scan shows which approvals it used and reports the affected findings as warnings.

## Verify signed receipts

~~~sh
atomic-agent project verify ./my-project
~~~

This command checks saved delivery, check-execution, gate-decision and milestone-report receipts. Use `atomic-agent project verify ./my-project --json` for machine-readable results. A valid signature confirms the saved receipt matches what was signed. A receipt changed outside the app can report a hash or signature mismatch. The terminal milestone card shows counts for signed, unsigned and problematic delivery, check and report receipts attributed to the milestone. An unsigned receipt has no verifiable signature. The signing key may have been unavailable, for example if the OS keychain was closed or missing. The card points to the full verifier for unsigned receipts and verification problems. A large archive can yield partial counts on the card. Run the command above for the full archive, including older receipts that lack project or milestone attribution. Incognito chats write no receipts and show no receipt summary.

An unbound chat in a folder with an existing `.atomic/project/project.json` skips writing project receipts, including receipts for checks and artifact manifests. The checks still execute.

Signatures support retrospective verification of the receipts present. It cannot tell whether a receipt was removed or whether current project files match the old delivery. A process running as your user with access to the signing key can sign replacement receipts.

For implementation details, see the [session storage guide](../../src/session/README.md), the [Fusion module guide](../../src/tools/fusion/README.md) and the [CLI reference](../../src/cli/README.md).
