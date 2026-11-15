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
   * Models that may judge a finished task, as `"<providerId>:<model>"`.
   * Unset or no reachable choice: the judge is `judgeProvider`, as before.
   */
  reviewers?: string[];
  /**
   * Pick the first reachable reviewer whose family (Anthropic, OpenAI,
   * local, other) differs from the worker's. `false`: the first
   * reachable reviewer. Default `true`.
   */
  crossFamilyReview?: boolean;
};

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
  };
}
