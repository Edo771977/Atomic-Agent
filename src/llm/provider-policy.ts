import { AsyncLocalStorage } from "node:async_hooks";
import { defaultProviderModelMode } from "../config/model-mode.js";
import { makeProviderPolicy, restrictionOrigin, type ProviderPolicy } from "../config/project-constraint-match.js";
import type { LlmProvider } from "./provider/llm-provider.js";
import { isLocalServerUrl } from "./provider/openai/local-server-url.js";
import { isLoopbackHost } from "./offline-network.js";
import { constraintHostOf } from "./provider/url-host.js";

export type { ProviderPolicy, ProviderPolicyStamp } from "../config/project-constraint-match.js";
export {
  hasProjectConstraints,
  makeProviderPolicy,
  providerPolicyFromStamp,
  resolveProjectConstraint,
  restrictionOrigin,
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

/**
 * The policy of one frame, shared by every role frame nested in it, so
 * a read taint set at tool dispatch (`tightenCurrentProviderPolicy`)
 * holds for the rest of the turn: the frame was opened once, by
 * `executeTurn`, before the read.
 */
export interface ProviderPolicyCell {
  policy: ProviderPolicy | undefined;
}

interface StoredFrame {
  readonly cell: ProviderPolicyCell;
  readonly role?: string;
  readonly sessionId?: string;
}

const frameStore = new AsyncLocalStorage<StoredFrame>();

/** Run `fn` with `policy` as the provider policy of every call it makes. */
export function runWithProviderPolicy<T>(
  policy: ProviderPolicy | undefined,
  fn: () => T,
  options: { role?: string; sessionId?: string } = {},
): T {
  const cell: ProviderPolicyCell = { policy };
  return frameStore.run(
    {
      cell,
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
  const frame = frameStore.getStore();
  if (frame === undefined) return undefined;
  return {
    policy: frame.cell.policy,
    ...(frame.role === undefined ? {} : { role: frame.role }),
    ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
  };
}

/** The policy of the call running now (`undefined`: unconstrained, or no frame). */
export function currentProviderPolicy(): ProviderPolicy | undefined {
  return frameStore.getStore()?.cell.policy;
}

/** The live policy cell of the frame running now, for a runtime that must tighten it later. */
export function currentProviderPolicyCell(): ProviderPolicyCell | undefined {
  return frameStore.getStore()?.cell;
}

/**
 * The policy satisfying both `a` and `b`: the providers both allow,
 * the egress classes both allow and the other machines both allow.
 * Keys join with " + " (a memory row written under it is seen by
 * neither folder alone, unless the allowed list is a subset of the
 * row's); `readFrom` and `movedFrom` are the union. Same key, or `a`
 * already carrying b's key parts: `a`'s key, with the lists still
 * intersected (issue #74: a stamp taken when the folder was stricter
 * keeps its lists after the folder is loosened), and `a` itself when
 * nothing changes.
 */
export function intersectProviderPolicies(a: ProviderPolicy, b: ProviderPolicy): ProviderPolicy {
  const providers = a.allowedProviders.filter((id) => b.allowedProviders.includes(id));
  const egress = a.allowedEgress.filter((cls) => b.allowedEgress.includes(cls));
  const hosts = a.allowedProviderHosts.filter((host) => b.allowedProviderHosts.includes(host));
  const readFrom = unionOf(a.readFrom, b.readFrom);
  const movedFrom = unionOf(a.movedFrom, b.movedFrom);
  if (a.key === b.key || policyCovers(a, b)) {
    const unchanged = providers.length === a.allowedProviders.length
      && egress.length === a.allowedEgress.length
      && hosts.length === a.allowedProviderHosts.length
      && readFrom.length === (a.readFrom?.length ?? 0)
      && movedFrom.length === (a.movedFrom?.length ?? 0);
    return unchanged
      ? a
      : makeProviderPolicy({ ...a, allowedProviders: providers, allowedEgress: egress, allowedProviderHosts: hosts, readFrom, movedFrom });
  }
  return makeProviderPolicy({
    // A part both keys carry is named once ("/a + /b" with "/b + /c").
    key: [...new Set([...a.key.split(" + "), ...b.key.split(" + ")])].join(" + "),
    allowedProviders: providers,
    allowedEgress: egress,
    allowedProviderHosts: hosts,
    matchedDir: a.matchedDir,
    readFrom,
    movedFrom,
  });
}

function unionOf(a: readonly string[] | undefined, b: readonly string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}



/** Whether `a` already carries constraint `b` (its key, or one of its " + " parts). */
export function policyCovers(a: ProviderPolicy, b: ProviderPolicy): boolean {
  if (a.key === b.key) return true;
  const parts = a.key.split(" + ");
  return b.key.split(" + ").every((part) => parts.includes(part));
}

/**
 * Narrow `cell` (default: the frame running now) to also satisfy
 * `policy`, for the rest of its life. Returns `false` when there is no
 * frame to narrow. Read taint (issue #33 group C) calls it at dispatch.
 */
export function tightenCurrentProviderPolicy(
  policy: ProviderPolicy,
  cell: ProviderPolicyCell | undefined = currentProviderPolicyCell(),
): boolean {
  if (cell === undefined) return false;
  cell.policy = cell.policy === undefined ? policy : intersectProviderPolicies(cell.policy, policy);
  return true;
}

/** Whether the current frame allows `providerId`; no frame or no policy allows everything. */
export function currentPolicyAllows(providerId: string): boolean {
  return currentProviderPolicy()?.allows(providerId) ?? true;
}

/**
 * What a frontend shows for a session's provider policy (issue #33 group
 * C): the TUI chip next to the offline switch, `/status`, the sidecar's
 * `get_provider_restriction` and `GET /api/sessions/{id}/provider-restriction`.
 */
export interface ProviderRestriction {
  /** `restricted to: local-llama` */
  label: string;
  allowedProviders: string[];
  /** The constraint entry (or entries, joined with " + "). */
  folder: string;
  /** The constrained folders the session read files from (read taint); empty for its own folder. */
  readFrom: string[];
  /** The constrained folders the chat was moved out of with their restriction (issue #68). */
  movedFrom: string[];
}

/** The restriction a policy puts on a session, or `null` for an unconstrained one. */
export function describeProviderRestriction(policy: ProviderPolicy | undefined): ProviderRestriction | null {
  if (policy === undefined) return null;
  return {
    label: `restricted to: ${describeAllowed(policy)}`,
    allowedProviders: [...policy.allowedProviders],
    folder: policy.key,
    readFrom: [...(policy.readFrom ?? [])],
    movedFrom: [...(policy.movedFrom ?? [])],
  };
}

/** One `/status` line for the restriction. */
export function formatProviderRestrictionLine(restriction: ProviderRestriction): string {
  const origin = restrictionOrigin({ readFrom: restriction.readFrom, movedFrom: restriction.movedFrom ?? [] });
  const why = origin === undefined ? `folder ${restriction.folder}` : origin.text.replace(/^this (chat|session) /, "");
  return `Providers: ${restriction.label} (${why})`;
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
export type ProviderRefusalReason = "not-allowed" | "none-allowed" | "no-policy" | "remote-endpoint";

export class ProviderNotAllowedError extends Error {
  readonly code = PROVIDER_NOT_ALLOWED_CODE;
  /**
   * `remote-endpoint` (issue #60): the id is allowed, but the provider is
   * a local server whose endpoint is another machine the folder does not
   * list in `allowedProviderHosts`, or cannot be read.
   */
  readonly reason: ProviderRefusalReason;
  readonly providerId: string | undefined;
  readonly policy: ProviderPolicy | undefined;
  readonly role: string;
  /** For `remote-endpoint`: the host refused, `null` when the endpoint cannot be read. */
  readonly endpointHost: string | null | undefined;

  constructor(input: {
    reason: ProviderRefusalReason;
    providerId?: string;
    policy?: ProviderPolicy;
    role?: string;
    endpointHost?: string | null;
    cause?: unknown;
  }) {
    const role = input.role ?? DEFAULT_ROLE;
    super(
      providerNotAllowedMessage(input.reason, role, input.policy, input.providerId, input.endpointHost),
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "ProviderNotAllowedError";
    this.reason = input.reason;
    this.providerId = input.providerId;
    this.policy = input.policy;
    this.role = role;
    this.endpointHost = input.endpointHost;
  }
}

/**
 * How to let `host` serve the folder(s) of `policy`: the
 * `allowedProviderHosts` of each constraint entry its key names.
 */
export function remoteEndpointOptInHint(policy: ProviderPolicy, host: string): string {
  const entries = policy.key.split(" + ").map((key) => `projects.constraints[${JSON.stringify(key)}].allowedProviderHosts`);
  return `add ${JSON.stringify(host)} to ${entries.join(" and ")}`;
}

function remoteEndpointSentence(policy: ProviderPolicy, providerId: string, host: string | null | undefined): string {
  if (host === null || host === undefined) {
    return `provider "${providerId}" is allowed, but its endpoint cannot be read, so it may be another machine; nothing was sent. ` +
      "Fix the provider's URL";
  }
  return `provider "${providerId}" is allowed, but its endpoint ${host} is another machine; nothing was sent. ` +
    `To allow it, ${remoteEndpointOptInHint(policy, host)}`;
}

function providerNotAllowedMessage(
  reason: ProviderRefusalReason,
  role: string,
  policy: ProviderPolicy | undefined,
  providerId: string | undefined,
  endpointHost: string | null | undefined,
): string {
  if (reason === "no-policy" || policy === undefined) {
    return `provider constraints are configured (projects.constraints) but ${role} carries no folder policy; ` +
      `nothing was sent${providerId === undefined ? "" : ` to "${providerId}"`}`;
  }
  const origin = restrictionOrigin(policy);
  const head = origin !== undefined
    ? `${origin.text}, which ${origin.plural ? "are" : "is"} restricted to: ${describeAllowed(policy)}`
    : `folder ${policy.key} is restricted to: ${describeAllowed(policy)}`;
  if (reason === "remote-endpoint") return `${head}; ${remoteEndpointSentence(policy, providerId ?? "(unknown)", endpointHost)}`;
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
 * Where a provider sends its requests, as far as a folder constraint is
 * concerned (issue #60). `local`: a server the operator runs
 * (`llama-server`, or an `openai-compatible` / `qwen-openai-compatible`
 * entry that is not a known cloud service), judged by `url` as well as
 * by id. Cloud providers are matched by id alone.
 */
export interface ProviderEndpoint {
  readonly local: boolean;
  /** The URL it is reached at; `undefined` when none is configured. */
  readonly url: string | undefined;
}

/**
 * The endpoint of a configured provider entry. A `llama-server` entry
 * without its own `url` reaches `localModelsUrl` (`localModels.url`, read
 * live by the provider). An `openai-compatible` / `qwen-openai-compatible`
 * entry is local unless it is marked `modelMode: "cloud"` or its base URL
 * is a known cloud service (`defaultProviderModelMode`). Whether a local
 * one is then judged by place depends on its host
 * (`providerEndpointRefusal`).
 */
export function providerEndpointOf(
  entry: { kind: string; url?: string | undefined; baseUrl?: string | undefined; modelMode?: string | undefined },
  localModelsUrl: string | undefined,
): ProviderEndpoint {
  if (entry.kind === "llama-server") return { local: true, url: entry.url ?? localModelsUrl };
  if (entry.kind !== "openai-compatible" && entry.kind !== "qwen-openai-compatible") return { local: false, url: entry.baseUrl ?? entry.url };
  if (entry.modelMode === "cloud") return { local: false, url: entry.baseUrl };
  const cloud = entry.baseUrl !== undefined &&
    defaultProviderModelMode({ kind: "openai-compatible", baseUrl: entry.baseUrl }) === "cloud";
  return { local: !cloud, url: entry.baseUrl };
}

/**
 * Why `policy` refuses `endpoint` although its provider id is allowed
 * (issue #60), or `undefined` when it does not: a local provider whose
 * URL is a private-network form other than literal loopback
 * (`isLocalServerUrl`, which also counts `*.localhost`, `0.0.0.0` and an
 * IPv6 form embedding a private or loopback IPv4 address: RFC 1918, link-local, CGNAT 100.64/10, IPv6
 * unique- and link-local, own-network names such as `.local`, `.lan`,
 * `.home.arpa`, `.internal`, single-label names) and whose host the
 * folder does not list in `allowedProviderHosts`. A public host keeps the
 * id-only match: it is a service the operator named, not a computer the
 * URL was quietly repointed to on the network. `{ host: null }` when the
 * URL cannot be read (fail closed). The same test `atomic-agent doctor`
 * runs.
 */
export function providerEndpointRefusal(
  policy: ProviderPolicy,
  endpoint: ProviderEndpoint,
): { host: string | null } | undefined {
  if (!endpoint.local) return undefined;
  const host = constraintHostOf(endpoint.url);
  if (host === null) return { host: null };
  // This machine by literal address only (`isLoopbackHost`: `localhost`,
  // 127/8, `::1`, IPv4-mapped 127/8): not `*.localhost` or `0.0.0.0`,
  // which name nothing a lookup cannot repoint, nor 6to4 / NAT64 /
  // IPv4-compatible spellings of 127.0.0.1, which reach other machines.
  if (isLoopbackHost(host)) return undefined;
  if (!isLocalServerUrl(endpoint.url)) return undefined;
  return policy.allowedProviderHosts.includes(host) ? undefined : { host };
}

/**
 * Whether `url` is a computer on the local network that `policy` lists
 * in `allowedProviderHosts` (issue #60), for a sender with no provider id
 * to match (memory embeddings): a private-network host only, so a public
 * host is never let through by this list, and an unreadable URL is not.
 */
export function networkEndpointListed(policy: ProviderPolicy, url: string | undefined): boolean {
  return isLocalServerUrl(url) && providerEndpointRefusal(policy, { local: true, url }) === undefined;
}

/**
 * Throw unless the current frame lets `providerId` receive a request.
 * `providerId` must be the ACTUAL provider about to be called, not the
 * id a caller asked for (an unknown id resolves to the active provider).
 * With `endpoint`, a provider allowed by id is also refused when it is a
 * local server on another machine the folder does not list (issue #60).
 */
export function assertProviderAllowed(
  providerId: string,
  options: { constraintsActive: () => boolean; role?: string; endpoint?: () => ProviderEndpoint | undefined },
): void {
  const frame = frameStore.getStore();
  const role = options.role ?? frame?.role;
  if (frame === undefined) {
    if (!options.constraintsActive()) return;
    throw new ProviderNotAllowedError({ reason: "no-policy", providerId, ...(role === undefined ? {} : { role }) });
  }
  const { policy } = frame.cell;
  if (policy === undefined) return;
  if (!policy.allows(providerId)) {
    throw new ProviderNotAllowedError({ reason: "not-allowed", providerId, policy, ...(role === undefined ? {} : { role }) });
  }
  const endpoint = options.endpoint?.();
  const refusal = endpoint === undefined ? undefined : providerEndpointRefusal(policy, endpoint);
  if (refusal === undefined) return;
  throw new ProviderNotAllowedError({
    reason: "remote-endpoint",
    providerId,
    policy,
    endpointHost: refusal.host,
    ...(role === undefined ? {} : { role }),
  });
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
 * Wrap a provider so `complete`, `completeStream`, `describeImage` and
 * (when it has one) `describeAudio`
 * check the current frame first (`assertProviderAllowed` against the
 * provider's own id and, given `endpoint`, where it is reached, read at
 * each call so a changed URL is judged). Every other member passes through to the provider
 * itself. The registry wraps every provider it builds, so a direct
 * `getProvider(id).complete(...)` (escalation, judge, the fusion format
 * check, `vision.describe`) is covered as well as the fallback seam.
 */
export function guardProvider(
  provider: LlmProvider,
  options: { constraintsActive: () => boolean; endpoint?: () => ProviderEndpoint | undefined },
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
  // Optional on the interface (`audio.listen`, upstream ATO-1164): guarded
  // only where the provider has it, so a caller's feature check still works.
  if (typeof provider.describeAudio === "function") {
    const describeAudio: NonNullable<LlmProvider["describeAudio"]> = async (request) => {
      check();
      return provider.describeAudio!(request);
    };
    overrides.describeAudio = describeAudio;
  }
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
