import { join } from "node:path";
import { learnedSkillScope, withLearnedTurn } from "../../skills/learning/learn-scope.js";
import { currentProviderPolicy } from "../../llm/provider-policy.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { RunTurnResult } from "../../agent/agent-contract.js";
import type { LlmStreamParams } from "../../agent/step/step-contract.js";
import type { AnswerChannel } from "../../prompt/answer-style.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import { buildCloudSubcallRequest } from "../../llm/provider/cloud-subcall.js";
import type { CompletionRequest, ToolCallTransport } from "../../llm/provider/completion-types.js";
import type { SlotManager } from "../../llm/slot-manager.js";
import { isIncognitoSession, type SessionState } from "../../session/index.js";
import { SkillChangeRecorder, skillCuratorPaths } from "../../skills/curator/index.js";
import {
  collectTurnExperience,
  EXPERIENCE_REVIEW_LIMITS,
  EXPERIENCE_REVIEW_SCHEMA,
  EXPERIENCE_REVIEW_SYSTEM,
  readPatchCandidates,
  runExperienceReview,
  shouldReviewTurn,
  takenSkillNames,
  type TurnExperience,
} from "../../skills/learning/index.js";
import { DEFAULT_SKILLS_SELF_LEARNING } from "../../config/skills-config.js";
import { listStarterSkillNames } from "../../skills/seed-starter-skills.js";
import type { SkillRegistry } from "../../skills/skill-registry.js";
import { SKILL_EDIT_TOOLS, skillTargets } from "../../tools/skill/skill-edit-tracker.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { TurnOrigin } from "../turn-controller.js";

/**
 * Self-learning after a long turn (ATO-67), wired like the next-step
 * suggestion: fired as a bare `void` after the turn is saved, its own
 * deadline, its abort handle in the shared teardown set. One review runs
 * at a time; a turn that ends while one is in flight is not reviewed
 * (OpenClaw runs reviews one by one too). The decision and the write
 * live in `skills/learning/experience-review.ts`.
 */
export interface ExperienceReviewerDeps {
  getConfig: () => AtomicAgentConfig;
  llmComplete: (params: LlmStreamParams) => Promise<CompletionResult>;
  slotManager: Pick<SlotManager, "sideCallSlotId">;
  resolveTransport: () => ToolCallTransport;
  skillRegistry: Pick<SkillRegistry, "listAll">;
  restricted?: (state: SessionState) => boolean;
  /** Teardown's handles (`pendingSessionNamings`, shared with naming). */
  pending: Set<AbortController>;
  isShutdown: () => boolean;
  logger: StructuredLogger;
  /**
   * The outside sources the session read in the turn that just ended
   * (`ApprovalGate.outsideContentSources`, the ATO-618 taint, recorded
   * whatever `agent.taintReview` says). Non-empty: the review runs, but a
   * skill it learned waits as a pending draft for the owner's approval.
   */
  outsideContentSources: (sessionId: string) => readonly string[];
  /** Test seam; the release list by default. */
  starterNames?: () => Promise<ReadonlySet<string>>;
}

/** Scheduled turns and Fusion workers skip review; eligible turns only draft. */
export type ReviewMode = "draft" | "skip";

const SKIPPED_ORIGINS: ReadonlySet<TurnOrigin> = new Set(["scheduler", "fusion"]);

/** The review mode for a turn from `origin`; `undefined` is an in-process caller. */
export function reviewModeForOrigin(origin: TurnOrigin | undefined, _answerChannel?: AnswerChannel): ReviewMode {
  if (origin !== undefined && SKIPPED_ORIGINS.has(origin)) return "skip";
  return "draft";
}

/** Fallback-chain partition for the call, like `title:` and `next-step:`. */
export const EXPERIENCE_REVIEW_SESSION_PREFIX = "learn:";

export interface ReviewTurnInfo {
  result: Pick<RunTurnResult, "reason" | "stepCount" | "stopCause">;
  origin: TurnOrigin | undefined;
  /** The reply's surface; `"desktop"` marks an HTTP turn from the desktop app. */
  answerChannel?: AnswerChannel;
  /** A `skill eval` run: it must not change skills either. */
  memoryReadOnly?: boolean;
}

function selfLearning(config: AtomicAgentConfig) {
  return config.skills.selfLearning ?? DEFAULT_SKILLS_SELF_LEARNING;
}

function editedSkills(experience: TurnExperience, workingDir: string, skillsDir: string): boolean {
  const tools: ReadonlySet<string> = new Set(SKILL_EDIT_TOOLS);
  return experience.steps.some((s) => tools.has(s.tool) && skillTargets(s.tool, s.args, workingDir, skillsDir).length > 0);
}

/** The model's answer: the emit tool's arguments on a cloud link, the text otherwise. */
function answerText(result: Pick<CompletionResult, "content" | "toolCalls">): string {
  const args = result.toolCalls?.[0]?.function?.arguments;
  if (typeof args === "string" && args.length > 0) return args;
  return result.content ?? "";
}

export function createExperienceReviewer(deps: ExperienceReviewerDeps) {
  let running: Promise<void> | null = null;

  const review = async (
    state: SessionState,
    experience: TurnExperience,
    hold: { sources: readonly string[]; origin?: string },
  ): Promise<void> => {
    if (deps.isShutdown()) return;
    const config = deps.getConfig();
    const scope = learnedSkillScope(config.paths.stateDir, state.projectRef?.folder ?? state.workingDir);
    const skillsDir = scope.skillsDir;
    const paths = skillCuratorPaths(scope.stateDir);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), EXPERIENCE_REVIEW_LIMITS.timeoutMs);
    timer.unref?.();
    deps.pending.add(abort);
    try {
      const targets = {
        records: deps.skillRegistry.listAll().map((e) => e.record),
        starterNames: await (deps.starterNames ?? listStarterSkillNames)(),
        globalSkillsDir: skillsDir,
        archiveDir: paths.archiveDir,
      };
      const candidates = await readPatchCandidates(skillsDir, experience.usedSkills);
      const takenNames = await takenSkillNames(targets);
      for (const name of await takenSkillNames({ ...targets, globalSkillsDir: config.paths.globalSkillsDir, archiveDir: join(config.paths.stateDir, "skills-archive") })) takenNames.add(name);
      const sessionId = `${EXPERIENCE_REVIEW_SESSION_PREFIX}${state.id}`;
      const transport = deps.resolveTransport();
      const result = await runExperienceReview({
        experience,
        candidates,
        takenNames,
        ask: async (prompt) => {
          const request: CompletionRequest & { grammar: string; slotId: number; sessionId: string } =
            transport === "native_tools"
              ? {
                  ...buildCloudSubcallRequest({
                    prompt,
                    emitFunctionName: "emit_skill_review",
                    argsSchema: EXPERIENCE_REVIEW_SCHEMA,
                    description: "Emit the review decision: none, create or patch",
                    sessionId,
                    maxTokens: EXPERIENCE_REVIEW_LIMITS.maxTokens,
                  }),
                  sessionId,
                  grammar: "",
                  slotId: -1,
                }
              : {
                  prompt,
                  sessionId,
                  grammar: "",
                  maxTokens: EXPERIENCE_REVIEW_LIMITS.maxTokens,
                  slotId: deps.slotManager.sideCallSlotId(),
                  ...(config.localModels.useServerTemplate === "off"
                    ? {}
                    : {
                        chat: {
                          system: EXPERIENCE_REVIEW_SYSTEM,
                          user: prompt,
                          prefixHash: "experience-review",
                          enableThinking: false,
                        },
                      }),
                };
          const completion = await deps.llmComplete({ ...request, signal: abort.signal });
          abort.signal.throwIfAborted();
          return answerText(completion);
        },
        apply: {
          recorder: new SkillChangeRecorder(skillsDir, paths),
          sessionId: state.id,
        },
        draft: { stateDir: scope.stateDir, ...hold },
      });
      if (deps.isShutdown()) return;
      if ("draft" in result) {
        // Not live, so no refresh: the draft folder is outside the skills tree.
        deps.logger.info("self-learning: held a skill for review", {
          sessionId: state.id,
          id: result.draft.id,
          skill: result.draft.name,
          action: result.draft.kind,
          reason: result.draft.reason,
          sources: result.draft.sources,
        });
      } else {
        deps.logger.debug("self-learning: nothing saved", {
          sessionId: state.id,
          reason: result.reason,
          ...("issues" in result && result.issues ? { issues: result.issues } : {}),
        });
      }
    } catch (err) {
      deps.logger.warn("self-learning review failed; skills were left as they were", {
        sessionId: state.id,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timer);
      deps.pending.delete(abort);
    }
  };

  /**
   * Fire a review for a finished turn when the setting, the origin, the
   * turn's length and its ending all allow it. Never awaits the call and
   * never throws: the caller has already saved and is about to return.
   */
  const maybeReview = (state: SessionState, info: ReviewTurnInfo): boolean => {
    try {
      if (running || deps.isShutdown() || currentProviderPolicy() || deps.restricted?.(state)) return false;
      if (reviewModeForOrigin(info.origin, info.answerChannel) === "skip") return false;
      if (info.memoryReadOnly === true || isIncognitoSession(state)) return false;
      if (info.result.reason !== "reply" && info.result.reason !== "finish") return false;
      // A ceiling ended the turn: its reply is a summary of unfinished work,
      // and a budget stop must not buy one more paid call.
      if (info.result.stopCause !== undefined) return false;
      const config = deps.getConfig();
      const { enabled, minSteps } = selfLearning(config);
      if (!enabled || info.result.stepCount < minSteps) return false;
      const experience = collectTurnExperience(state.turns);
      // Read now: the taint is cleared when the session's next turn starts.
      const outsideSources = [...deps.outsideContentSources(state.id)];
      const verdict = shouldReviewTurn({
        enabled,
        stepCount: info.result.stepCount,
        minSteps,
        experience,
        outsideSources,
        turnEditedSkills: experience !== null && editedSkills(experience, state.workingDir, config.paths.globalSkillsDir),
      });
      if (!verdict.review) return false;
      const hold = { sources: outsideSources, ...(info.origin !== undefined ? { origin: info.origin } : {}) };
      running = review(state, verdict.experience, hold)
        .catch((err: unknown) => {
          deps.logger.warn("self-learning review failed", { sessionId: state.id, error: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => {
          running = null;
        });
      return true;
    } catch (err) {
      deps.logger.warn("self-learning review skipped", {
        sessionId: state.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  /** Settles when no review is in flight (tests, an orderly shutdown). */
  const whenIdle = (): Promise<void> => running ?? Promise.resolve();

  const withTurn = <T>(state: SessionState, run: () => Promise<T>): Promise<T> => {
    const config = deps.getConfig();
    return selfLearning(config).enabled
      ? withLearnedTurn(config.paths.stateDir, state.projectRef?.folder ?? state.workingDir, run)
      : run();
  };
  return { maybeReview, whenIdle, withTurn };
}
