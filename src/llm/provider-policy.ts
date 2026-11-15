import { AsyncLocalStorage } from "node:async_hooks";
import type { ProviderPolicy } from "../config/project-constraint-match.js";
import type { LlmProvider } from "./provider/llm-provider.js";

export type { ProviderPolicy, ProviderPolicyStamp } from "../config/project-constraint-match.js";
export {
  hasProjectConstraints,
  makeProviderPolicy,
  providerPolicyFromStamp,
  resolveProjectConstraint,
  toProviderPolicyStamp,
} from "../config/project-constraint-match.js";

/**
 * Per-folder provider constraints at dispatch (issue #33 §5). See
 * ../docs/provider-policy.md.
 *
 * The policy of the call running now travels in an AsyncLocalStorage
 * frame, the way the approval workdir does (`approval-workdir.ts`):
 * `executeTurn` and every background entry point set it once, and every
 * provider call underneath reads it, without threading it through each
 * call site. A frame whose `policy` is `undefined` is an unconstrained
 * folder; NO frame at all, while any constraint is configured, is a
 * caller nobody scoped, and is refused (fail closed).
 */
export interface ProviderPolicyFrame {
  /** The folder's policy, or `undefined` when no constraint covers it. */
  readonly policy: ProviderPolicy | undefined;
  /** What is calling, for the refusal ("the main model", "fusion judge"). */
  readonly role?: string;
  /**
   * The session this frame was set for, when the setter knows it. A
   * lookup for another session (a task drained inside some turn) then
   * does not borrow this frame (`effectivePolicyForSession`).
   */
  readonly sessionId?: string;
}

const frameStore = new AsyncLocalStorage<ProviderPolicyFrame>();

/** Run `fn` with `policy` as the provider policy of every call it makes. */
export function runWithProviderPolicy<T>(
  policy: ProviderPolicy | undefined,
  fn: () => T,
  options: { role?: string; sessionId?: string } = {},
): T {
  return frameStore.run(
    {
      policy,
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    },
    fn,
  );
}

/**
 * Run `fn` under the current policy, naming the role for a refusal. With
 * no frame there is no policy to keep, so `fn` runs as is and a guarded
 * call inside it still fails closed.
 */
export function runWithProviderRole<T>(role: string, fn: () => T): T {
  const frame = frameStore.getStore();
  if (frame === undefined) return fn();
  return frameStore.run({ ...frame, role }, fn);
}

/** The frame of the call running now, or `undefined` when nothing scoped it. */
export function currentProviderPolicyFrame(): ProviderPolicyFrame | undefined {
  return frameStore.getStore();
}

/** The policy of the call running now (`undefined`: unconstrained, or no frame). */
export function currentProviderPolicy(): ProviderPolicy | undefined {
  return frameStore.getStore()?.policy;
}

/** Whether the current frame allows `providerId`; no frame or no policy allows everything. */
export function currentPolicyAllows(providerId: string): boolean {
  return currentProviderPolicy()?.allows(providerId) ?? true;
}

export const PROVIDER_NOT_ALLOWED_CODE = "ATOMIC_AGENT_PROVIDER_NOT_ALLOWED";

const DEFAULT_ROLE = "this request";

function describeAllowed(policy: ProviderPolicy): string {
  return policy.allowedProviders.length === 0 ? "no provider" : policy.allowedProviders.join(", ");
}

/**
 * A provider call refused before anything was sent, because the folder's
 * constraint does not allow the provider (or no allowed provider is
 * left, or the call carried no policy while constraints exist).
 *
 * Like an offline refusal it is this machine's policy, not the
 * provider failing: the chain skips the link without a breaker failure,
 * cooldown or sticky override, and the turn never waits for it.
 */
export class ProviderNotAllowedError extends Error {
  readonly code = PROVIDER_NOT_ALLOWED_CODE;
  readonly reason: "not-allowed" | "none-allowed" | "no-policy";
  readonly providerId: string | undefined;
  readonly policy: ProviderPolicy | undefined;
  readonly role: string;

  constructor(input: {
    reason: "not-allowed" | "none-allowed" | "no-policy";
    providerId?: string;
    policy?: ProviderPolicy;
    role?: string;
    cause?: unknown;
  }) {
    const role = input.role ?? DEFAULT_ROLE;
    super(
      providerNotAllowedMessage(input.reason, role, input.policy, input.providerId),
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "ProviderNotAllowedError";
    this.reason = input.reason;
    this.providerId = input.providerId;
    this.policy = input.policy;
    this.role = role;
  }
}

function providerNotAllowedMessage(
  reason: "not-allowed" | "none-allowed" | "no-policy",
  role: string,
  policy: ProviderPolicy | undefined,
  providerId: string | undefined,
): string {
  if (reason === "no-policy" || policy === undefined) {
    return `provider constraints are configured (projects.constraints) but ${role} carries no folder policy; ` +
      `nothing was sent${providerId === undefined ? "" : ` to "${providerId}"`}`;
  }
  const head = `folder ${policy.key} is restricted to: ${describeAllowed(policy)}`;
  return reason === "none-allowed"
    ? `${head}; no allowed provider can serve ${role}`
    : `${head}; provider "${providerId ?? "(unknown)"}" may not serve ${role}, nothing was sent`;
}

/** Is `err` (or one of its causes) a provider-policy refusal? */
export function isProviderNotAllowed(err: unknown): boolean {
  return findProviderNotAllowed(err) !== undefined;
}

export function findProviderNotAllowed(err: unknown): ProviderNotAllowedError | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    if (current instanceof ProviderNotAllowedError) return current;
    const next = (current as { cause?: unknown }).cause;
    if (next === current) return undefined;
    current = next;
  }
  return undefined;
}

/** The terminal refusal: no provider the folder allows can serve `role`. */
export function noAllowedProviderError(
  policy: ProviderPolicy,
  role: string = currentProviderPolicyFrame()?.role ?? DEFAULT_ROLE,
  cause?: unknown,
): ProviderNotAllowedError {
  return new ProviderNotAllowedError({ reason: "none-allowed", policy, role, ...(cause === undefined ? {} : { cause }) });
}

/**
 * Throw unless the current frame lets `providerId` receive a request.
 * `providerId` must be the ACTUAL provider about to be called, not the
 * id a caller asked for (an unknown id resolves to the active provider).
 */
export function assertProviderAllowed(
  providerId: string,
  options: { constraintsActive: () => boolean; role?: string },
): void {
  const frame = frameStore.getStore();
  const role = options.role ?? frame?.role;
  if (frame === undefined) {
    if (!options.constraintsActive()) return;
    throw new ProviderNotAllowedError({ reason: "no-policy", providerId, ...(role === undefined ? {} : { role }) });
  }
  const { policy } = frame;
  if (policy === undefined || policy.allows(providerId)) return;
  throw new ProviderNotAllowedError({ reason: "not-allowed", providerId, policy, ...(role === undefined ? {} : { role }) });
}

/**
 * The refusal `assertProviderAllowed` would throw, or `undefined` when the
 * call may go ahead. For callers that answer with a tool error instead
 * of throwing (Core-proxied media is checked against `"openrouter"`).
 * Without `constraintsActive` a call with no frame is let through: only
 * a frame's policy refuses (setup flows outside any session).
 */
export function providerPolicyRefusalFor(
  providerId: string,
  role: string,
  options: { constraintsActive?: () => boolean } = {},
): ProviderNotAllowedError | undefined {
  try {
    assertProviderAllowed(providerId, { constraintsActive: options.constraintsActive ?? (() => false), role });
    return undefined;
  } catch (err) {
    if (err instanceof ProviderNotAllowedError) return err;
    throw err;
  }
}

const GUARDED = new WeakSet<object>();

/**
 * Wrap a provider so `complete`, `completeStream` and `describeImage`
 * check the current frame first (`assertProviderAllowed` against the
 * provider's own id). Every other member passes through to the provider
 * itself. The registry wraps every provider it builds, so a direct
 * `getProvider(id).complete(...)` (escalation, judge, the fusion format
 * check, `vision.describe`) is covered as well as the fallback seam.
 */
export function guardProvider(
  provider: LlmProvider,
  options: { constraintsActive: () => boolean },
): LlmProvider {
  if (GUARDED.has(provider)) return provider;
  const check = (): void => assertProviderAllowed(provider.id, options);
  const complete: LlmProvider["complete"] = async (request) => {
    check();
    return provider.complete(request);
  };
  const describeImage: LlmProvider["describeImage"] = async (request) => {
    check();
    return provider.describeImage(request);
  };
  const completeStream: LlmProvider["completeStream"] = (request) => {
    async function* guarded(): ReturnType<LlmProvider["completeStream"]> {
      check();
      return yield* provider.completeStream(request);
    }
    return guarded();
  };
  const overrides: Record<PropertyKey, unknown> = { complete, completeStream, describeImage };
  const proxy = new Proxy(provider, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  GUARDED.add(proxy);
  return proxy;
}
