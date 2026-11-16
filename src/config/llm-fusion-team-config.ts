import { isSetAsideString } from "./config-primitives.js";
import { ConfigValidationError } from "./config-validation-error.js";

/**
 * `llm.runMode.fusion.team` (issue #37): which models may direct a fusion
 * session, which may work its tasks and which may review them. Each
 * member is `"<providerId>:<model>"`, split at the first `:`, so one
 * provider entry can sit in the team with several models. Without the
 * block, fusion runs on `orchestratorProvider` / `workerProvider` as
 * before; with it, those keys name the defaults.
 */
export type UserFusionTeamConfig = {
  /**
   * Models that may direct a fusion session (plan, delegate, reply), as
   * `"<providerId>:<model>"`. At least one; each provider id must name a
   * configured provider. The director is chosen per session;
   * `orchestratorProvider` names the default one.
   */
  directors: string[];
  /**
   * Models that may run a delegated task, as `"<providerId>:<model>"`.
   * A task's worker must be one of these. `workerProvider` names the
   * default when it is a member; otherwise the first reachable one.
   */
  workers?: string[];
  /**
   * Models that may review a finished task, as `"<providerId>:<model>"`.
   * Listing any turns per-task review on unless `review` is `"off"`
   * (issue #38). No fitting reviewer for a task: `judgeProvider` reviews
   * it when `judge` is on, else no model does.
   */
  reviewers?: string[];
  /**
   * Among reviewers no weaker than the worker (by the model tier table;
   * a local model is below any cloud one), prefer one whose family
   * (Anthropic, OpenAI, local, other) differs from the worker's. A
   * stronger reviewer of the worker's own family still comes before an
   * equal one of another. `false`: config order within each strength.
   * Default `true`.
   */
  crossFamilyReview?: boolean;
  /**
   * Per-task review by a reviewer (issue #38). Unset: on when
   * `reviewers` lists any, else `judge` decides as before. `"on"` or
   * `"off"` set it explicitly, whatever `judge` says.
   */
  review?: "on" | "off";
  /**
   * How many extra passes a task gets when its review asks for changes,
   * within the turn's budget: 0, 1 or 2. Default 2.
   */
  reviewPasses?: 0 | 1 | 2;
  /**
   * How often, in minutes, a running task of a team run is checked for
   * progress (issue #43): 0 to 60, 0 turns the watch off. A task's own
   * `watchMinutes` in `fusion.delegate` wins. Default 5.
   */
  watchEveryMinutes?: number;
  /**
   * At most this many judge calls per watched task when its progress is
   * unclear, across all its runs (review passes and an escalation
   * re-run), counted against the turn's budget: 1 to 10. Default 3.
   */
  watchMaxChecks?: number;
};

export const FUSION_TEAM_REVIEW_MODES: readonly NonNullable<UserFusionTeamConfig["review"]>[] = ["on", "off"];
export const FUSION_TEAM_REVIEW_PASSES: readonly NonNullable<UserFusionTeamConfig["reviewPasses"]>[] = [0, 1, 2];
/** `reviewPasses` when unset. */
export const DEFAULT_FUSION_TEAM_REVIEW_PASSES: NonNullable<UserFusionTeamConfig["reviewPasses"]> = 2;

/** `watchEveryMinutes` when unset. */
export const DEFAULT_FUSION_TEAM_WATCH_EVERY_MINUTES = 5;
/** `watchMaxChecks` when unset. */
export const DEFAULT_FUSION_TEAM_WATCH_MAX_CHECKS = 3;
/** The bounds of `watchEveryMinutes` (and of a task's `watchMinutes`, clamped). */
export const FUSION_TEAM_WATCH_MAX_MINUTES = 60;
export const FUSION_TEAM_WATCH_MAX_CHECKS_LIMIT = 10;

/** The two halves of a team member; null when `raw` is not `"<providerId>:<model>"` with both halves non-blank. */
export function splitTeamMemberRef(raw: string): { providerId: string; model: string } | null {
  const at = raw.indexOf(":");
  if (at <= 0) return null;
  const providerId = raw.slice(0, at);
  const model = raw.slice(at + 1);
  if (providerId.trim().length === 0 || model.trim().length === 0) return null;
  return { providerId, model };
}

function parseMembers(
  raw: unknown,
  providerIds: ReadonlySet<string>,
  field: string,
  expectation: string,
): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ConfigValidationError(field, expectation);
  }
  const seen = new Set<string>();
  return raw.map((value, i) => {
    const at = `${field}[${i}]`;
    const colon = typeof value === "string" ? value.indexOf(":") : -1;
    if (typeof value !== "string" || colon <= 0) {
      throw new ConfigValidationError(at, `expected "<providerId>:<model>", got ${JSON.stringify(value)}`);
    }
    const split = splitTeamMemberRef(value);
    if (split === null) throw new ConfigValidationError(at, `empty model in ${JSON.stringify(value)}`);
    if (!providerIds.has(split.providerId)) {
      throw new ConfigValidationError(at, `unknown provider id ${JSON.stringify(split.providerId)}`);
    }
    if (seen.has(value)) throw new ConfigValidationError(at, `duplicate member ${JSON.stringify(value)}`);
    seen.add(value);
    return value;
  });
}

/** Validate `llm.runMode.fusion.team` against the configured provider ids. */
export function parseFusionTeam(
  raw: unknown,
  providerIds: ReadonlySet<string>,
  field: string,
): UserFusionTeamConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected object");
  }
  const obj = raw as Record<string, unknown>;
  const out: UserFusionTeamConfig = {
    directors: parseMembers(obj.directors, providerIds, `${field}.directors`, "expected a non-empty array of members"),
  };
  for (const key of ["workers", "reviewers"] as const) {
    if (obj[key] !== undefined) {
      out[key] = parseMembers(obj[key], providerIds, `${field}.${key}`, "expected an array of members, at least one");
    }
  }
  if (obj.crossFamilyReview !== undefined) {
    if (typeof obj.crossFamilyReview !== "boolean") {
      throw new ConfigValidationError(`${field}.crossFamilyReview`, "expected boolean");
    }
    out.crossFamilyReview = obj.crossFamilyReview;
  }
  if (obj.review !== undefined && !isSetAsideString(obj.review, FUSION_TEAM_REVIEW_MODES, `${field}.review`, undefined)) {
    if (obj.review !== "on" && obj.review !== "off") {
      throw new ConfigValidationError(`${field}.review`, "expected on|off");
    }
    out.review = obj.review;
  }
  if (obj.reviewPasses !== undefined) {
    const passes = FUSION_TEAM_REVIEW_PASSES.find((n) => n === obj.reviewPasses);
    if (passes === undefined) {
      throw new ConfigValidationError(`${field}.reviewPasses`, "expected 0, 1 or 2");
    }
    out.reviewPasses = passes;
  }
  const integerIn = (key: "watchEveryMinutes" | "watchMaxChecks", min: number, max: number): void => {
    const value = obj[key];
    if (value === undefined) return;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new ConfigValidationError(`${field}.${key}`, `expected an integer from ${min} to ${max}`);
    }
    out[key] = value;
  };
  integerIn("watchEveryMinutes", 0, FUSION_TEAM_WATCH_MAX_MINUTES);
  integerIn("watchMaxChecks", 1, FUSION_TEAM_WATCH_MAX_CHECKS_LIMIT);
  return out;
}

/**
 * The team without the members whose provider `drop` matches, or
 * undefined when no director is left (a team must have one, so the file
 * stays readable). Returns `team` itself when nothing matched.
 */
export function teamWithoutProviders(
  team: UserFusionTeamConfig,
  drop: (providerId: string) => boolean,
): UserFusionTeamConfig | undefined {
  const keep = (list: readonly string[]): string[] =>
    list.filter((member) => !drop(splitTeamMemberRef(member)?.providerId ?? ""));
  const directors = keep(team.directors);
  const workers = team.workers === undefined ? undefined : keep(team.workers);
  const reviewers = team.reviewers === undefined ? undefined : keep(team.reviewers);
  if (
    directors.length === team.directors.length &&
    workers?.length === team.workers?.length &&
    reviewers?.length === team.reviewers?.length
  ) {
    return team;
  }
  if (directors.length === 0) return undefined;
  return {
    directors,
    ...(workers !== undefined && workers.length > 0 ? { workers } : {}),
    ...(reviewers !== undefined && reviewers.length > 0 ? { reviewers } : {}),
    ...(team.crossFamilyReview === undefined ? {} : { crossFamilyReview: team.crossFamilyReview }),
    ...(team.review === undefined ? {} : { review: team.review }),
    ...(team.reviewPasses === undefined ? {} : { reviewPasses: team.reviewPasses }),
    ...(team.watchEveryMinutes === undefined ? {} : { watchEveryMinutes: team.watchEveryMinutes }),
    ...(team.watchMaxChecks === undefined ? {} : { watchMaxChecks: team.watchMaxChecks }),
  };
}
