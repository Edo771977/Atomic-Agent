/**
 * Who a team member is, compared by identity rather than spelling
 * (issue #98): the provider plus its model, the `default` alias (or no
 * model) standing for the provider's resolved default. `codex-cli:default`
 * and `codex-cli:<the resolved default>` are the same member; a member
 * on another provider, or another model, is not. One place for the plan
 * gate's coverage check and the recorded reviewer identity.
 */

/** The provider's resolved default model, when the runtime knows it. */
export type DefaultModelOf = (providerId: string) => string | undefined;

const DEFAULT_ALIAS = "default";

function identityOf(ref: string, defaultModelOf?: DefaultModelOf): { provider: string; model: string } {
  // `provider`, `provider:` and `provider:default` all name the provider's default.
  const trimmed = ref.trim();
  const colon = trimmed.indexOf(":");
  const provider = colon < 0 ? trimmed : trimmed.slice(0, colon);
  const raw = colon < 0 ? "" : trimmed.slice(colon + 1).trim();
  const model = raw.length === 0 || raw === DEFAULT_ALIAS ? (defaultModelOf?.(provider) ?? DEFAULT_ALIAS) : raw;
  return { provider, model };
}

/** Whether two member refs (`"<providerId>:<model>"`, or null for none) name the same member. */
export function sameMember(a: string | null, b: string | null, defaultModelOf?: DefaultModelOf): boolean {
  if (a === null || b === null) return a === b;
  if (a === b) return true;
  const x = identityOf(a, defaultModelOf);
  const y = identityOf(b, defaultModelOf);
  return x.provider === y.provider && x.model === y.model;
}

/**
 * The reviewer as recorded with a verdict: its provider, the model it
 * effectively ran (only when the provider reported one: a subscription
 * CLI that reports none leaves it absent), and the plan row's ref when
 * that names a different member.
 */
export interface ReviewerIdentity {
  provider: string;
  model?: string;
  planRef?: string;
}

export function reviewerIdentity(
  provider: string,
  effectiveModel: string | undefined,
  planRef: string | null | undefined,
  defaultModelOf?: DefaultModelOf,
): ReviewerIdentity {
  const model = effectiveModel?.trim();
  const out: ReviewerIdentity = { provider, ...(model === undefined || model.length === 0 ? {} : { model }) };
  if (planRef === undefined || planRef === null) return out;
  const plan = identityOf(planRef, defaultModelOf);
  const differs = plan.provider !== provider || (out.model !== undefined && plan.model !== DEFAULT_ALIAS && plan.model !== out.model);
  return differs ? { ...out, planRef } : out;
}
