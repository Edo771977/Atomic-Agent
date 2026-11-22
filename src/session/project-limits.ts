export const PROJECT_STORE_DIR_PARTS = [".atomic", "project"] as const;

/**
 * Bounds on a stored or updated project. Text is clipped with an
 * ellipsis; a model update over an array cap is refused (the tool turns
 * it into an error the model can act on); a stored one is cut. Plan-row
 * decision references and executable check lists are validated strictly.
 *  - `text` 2000: what/users/how, a summary — a paragraph, not a spec.
 *  - `shortText` 300: a success criterion, a game field, a reason.
 *  - `title` 160: a task or milestone title, as `PLAN_STEP_MAX_CHARS`.
 *  - `id` 64, `criterionId` 32 and `memberRef` 256: identifiers.
 *  - `successCriteria` 20, `milestones` 16, `rows` 64 (the task tree's
 *    node ceiling), `runIds` 32 per milestone (the newest are kept).
 *  - `correctionNote` 2000 and `corrections` 8 per milestone (the newest
 *    are kept): the person's notes at a milestone gate.
 *  - `attachments` 8 per milestone, `attachmentPath` 1024: the result's
 *    pictures (a caption is `shortText`). Criteria facts: one per criterion.
 *  - `history` 4 per milestone (the newest are kept): earlier work's evidence.
 *  - `decisions` 20 (schema v2): the brief's decisions, each `shortText`,
 *    and a plan row's decision ids.
 *  - `checks` 16 per row, shared with the contract-check parser.
 *  - `backlog` 32 (schema v2): open or promoted items, `title` long, note
 *    and condition `shortText`; `backlogStored` 128: every item the file
 *    keeps, dropped ones included (a stored list is cut there).
 */
export const PROJECT_LIMITS = {
  checks: 16,
  text: 2000,
  shortText: 300,
  title: 160,
  id: 64,
  memberRef: 256,
  successCriteria: 20,
  criterionId: 32,
  milestones: 16,
  rows: 64,
  runIds: 32,
  correctionNote: 2000,
  corrections: 8,
  attachments: 8,
  attachmentPath: 1024,
  history: 4,
  decisions: 20,
  backlog: 32,
  backlogStored: 128,
  lessonFiles: 128,
  lessonFileBytes: 16 * 1024,
  lessonTouches: 32,
  lessonTouchPath: 1024,
} as const;
