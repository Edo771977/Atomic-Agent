import type { UserFusionProjectConfig } from "../../config/llm-run-mode-config.js";
import { reviewEnabled, teamMembers, type TeamMember } from "../../llm/run-mode/fusion-team.js";
import type { OutcomeRecord } from "./outcome-log.js";
import type { ProjectPlanContext } from "./project-tools.js";
import { resolveTeamRouting, type FusionTeamContext } from "./team-routing.js";
import type { WorkerPricing } from "./worker-result.js";

/** `measuredRouting` defaults (`resolveRunMode`): the estimates use the same thresholds, on or off. */
export const PROJECT_ESTIMATE_MIN_SAMPLES = 8;
export const PROJECT_ESTIMATE_DAYS = 30;

export interface ProjectPlanContextInput {
  /** The team (`teamContextFromConfig`); undefined: no team, the worker leg serves. */
  team: FusionTeamContext | undefined;
  /** `fusion.judge`, for whether tasks get a review without a team review setting. */
  judge?: "on" | "off";
  /** The folder's provider policy (`currentPolicyAllows`). */
  allows: (providerId: string) => boolean;
  /** The worker leg (`ResolvedRunMode.workerProviderId` / `workerModel`); null outside fusion. */
  workerLeg: { providerId: string; model: string } | null;
  /** The session's chosen worker (`metadata.fusionWorker`). */
  currentWorker?: TeamMember | null;
  records: readonly OutcomeRecord[];
  pricing: (providerId: string, model: string) => WorkerPricing | undefined;
  /** Whether the provider is a local server (shares the measured speed). */
  isLocal: (providerId: string) => boolean;
  tokensPerSecond: () => number | null;
  measured?: { minSamples?: number; days?: number };
  projectConfig?: UserFusionProjectConfig;
  now?: number;
}

/**
 * What `project.plan` assigns and estimates with (issue #39), bound to
 * the live team, the folder's policy and the outcome history: the same
 * workers, default worker and reviewer pick `fusion.delegate` routes by
 * (`resolveTeamRouting`), so the plan the person approves is the one the
 * dispatch runs.
 */
export function projectPlanContextFrom(input: ProjectPlanContextInput): ProjectPlanContext {
  const routing =
    input.team === undefined
      ? undefined
      : resolveTeamRouting(input.team, {
          allows: input.allows,
          ...(input.currentWorker === undefined ? {} : { currentWorker: () => input.currentWorker ?? null }),
        });
  const legMember: TeamMember | null =
    input.workerLeg === null || !input.allows(input.workerLeg.providerId)
      ? null
      : {
          providerId: input.workerLeg.providerId,
          model: input.workerLeg.model,
          ref: `${input.workerLeg.providerId}:${input.workerLeg.model}`,
        };
  const workers = routing?.tasks?.workers ?? (legMember === null ? [] : [legMember]);
  const defaultWorker = routing?.tasks === undefined ? legMember : routing.tasks.defaultWorker ?? legMember;
  const ok = (m: TeamMember): boolean => input.allows(m.providerId) && (input.team?.reachable(m) ?? true);
  const reviewers = input.team === undefined ? [] : teamMembers(input.team.team, "reviewers").filter(ok);
  return {
    workers,
    reviewers,
    defaultWorker,
    reviewerFor: (worker) => routing?.reviewerFor(worker) ?? null,
    reviewOn: reviewers.length > 0 && reviewEnabled(input.team?.team, input.judge),
    records: input.records,
    pricing: (member) => input.pricing(member.providerId, member.model),
    tokensPerSecond: (member) => (input.isLocal(member.providerId) ? input.tokensPerSecond() : null),
    minSamples: input.measured?.minSamples ?? PROJECT_ESTIMATE_MIN_SAMPLES,
    days: input.measured?.days ?? PROJECT_ESTIMATE_DAYS,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.projectConfig === undefined ? {} : { projectConfig: input.projectConfig }),
  };
}
