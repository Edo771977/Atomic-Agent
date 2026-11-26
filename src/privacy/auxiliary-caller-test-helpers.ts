import { SIDE_QUESTION_SESSION_PREFIX } from "../runtime/side-question.js";
import { EXPERIENCE_REVIEW_SESSION_PREFIX } from "../runtime/composition/runtime-experience-review.js";
import { PROMPT_ENHANCE_SESSION_PREFIX } from "../runtime/prompt-enhancer.js";
import { SESSION_TITLE_SESSION_PREFIX } from "../session/session-title.js";
import { NEXT_STEP_SESSION_PREFIX } from "../session/session-next-step.js";
import { EXTRACT_SESSION_PREFIX } from "../tools/browser/extract-request.js";
import { RISK_REVIEW_SESSION_PREFIX } from "../approval/risk-review.js";
import { GOAL_JUDGE_SESSION_PREFIX } from "../agent/goal/goal-judge.js";
import { COMPACTION_SESSION_PREFIX } from "../runtime/context-compaction-model.js";
import { REWRITER_SESSION_PREFIX } from "../memory/retrieve/query-rewriter-runner.js";
import { LINK_GENERATOR_SESSION_PREFIX } from "../memory/links/link-generator-runner.js";
import { VOTE_SESSION_PREFIX } from "../memory/voting/vote-runner.js";
import { NOTE_RECONCILE_SESSION_PREFIX } from "../memory/reconcile/note-reconcile-runner.js";
import { REFLECTION_SESSION_PREFIX } from "../memory/reflection/reflection-runner.js";

/** Imported from the production callers, independently of the registry list. */
export const AUXILIARY_CALLERS = [
  ["side question", SIDE_QUESTION_SESSION_PREFIX], ["experience review", EXPERIENCE_REVIEW_SESSION_PREFIX],
  ["prompt enhance", PROMPT_ENHANCE_SESSION_PREFIX], ["session title", SESSION_TITLE_SESSION_PREFIX],
  ["next step", NEXT_STEP_SESSION_PREFIX], ["browser extract", EXTRACT_SESSION_PREFIX],
  ["risk review", RISK_REVIEW_SESSION_PREFIX], ["goal judge", GOAL_JUDGE_SESSION_PREFIX],
  ["compaction", COMPACTION_SESSION_PREFIX], ["rewriter", REWRITER_SESSION_PREFIX],
  ["link generator", LINK_GENERATOR_SESSION_PREFIX], ["vote", VOTE_SESSION_PREFIX],
  ["note reconcile", NOTE_RECONCILE_SESSION_PREFIX], ["reflection", REFLECTION_SESSION_PREFIX],
] as const;

export const CALLER_PARTITIONS = AUXILIARY_CALLERS.map(([, prefix]) => prefix.slice(0, -1));
