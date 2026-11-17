import { getConfig } from "../config/index.js";
import {
  findProviderNotAllowed,
  PROVIDER_NOT_ALLOWED_CODE,
  type ProviderNotAllowedError,
} from "../llm/provider-policy.js";
import {
  EGRESS_NOT_ALLOWED_CODE,
  EgressNotAllowedError,
  ShellNetworkNotAllowedError,
} from "../tools/tool-egress.js";

/**
 * A turn that ended because a per-folder constraint (`projects.constraints`)
 * refused it: this machine's policy, not the provider failing. Every
 * surface (TUI chat line, CLI `run` stderr, sidecar `session_failed`,
 * HTTP failure frame) shows the same sentence and hint and carries the
 * same stable `code`, so a host branches on the code instead of reading
 * "couldn't get a reply from the provider", which is not what happened.
 */
export interface ConstraintRefusal {
  readonly code: typeof PROVIDER_NOT_ALLOWED_CODE | typeof EGRESS_NOT_ALLOWED_CODE;
  /** One sentence: what the folder allows and what was refused. */
  readonly message: string;
  /** The constraint entry (its folder key), when known. */
  readonly folder: string | null;
  /** The providers the folder allows (provider refusals), else empty. */
  readonly allowedProviders: readonly string[];
  /** The refused provider id (provider refusals), when known. */
  readonly providerId: string | null;
  /** The egress class to add to `allowedEgress` (egress refusals), when one would allow it. */
  readonly egressClass: string | null;
  /**
   * An allowed local provider refused for its endpoint (issue #60): the
   * other machine's host to add to `allowedProviderHosts`, `null` when
   * the endpoint cannot be read. Absent for every other refusal.
   */
  readonly endpointHost?: string | null;
}

/** The constraint refusal in `err` or its causes, or `null`. */
export function findConstraintRefusal(err: unknown): ConstraintRefusal | null {
  const provider = findProviderNotAllowed(err);
  if (provider !== undefined) return describeProviderRefusal(provider);
  const egress = findEgressRefusal(err);
  if (egress !== undefined) {
    return {
      code: EGRESS_NOT_ALLOWED_CODE,
      message: `This folder (${egress.policyKey}) is restricted: ${egress.tool} can't send content off this machine here.`,
      folder: egress.policyKey,
      allowedProviders: [],
      providerId: null,
      egressClass: egress.egressClass,
    };
  }
  return null;
}

/**
 * The hint under the sentence. With a local model configured the turn can
 * go on locally; otherwise the constraint itself is what to change.
 */
export function constraintRefusalHint(
  refusal: ConstraintRefusal,
  opts: { readonly localModelConfigured: boolean },
): string {
  const folder = refusal.folder === null ? "<folder>" : refusal.folder;
  if (refusal.code === EGRESS_NOT_ALLOWED_CODE) {
    return refusal.egressClass === null
      ? `no allowedEgress class allows this in projects.constraints[${JSON.stringify(folder)}]`
      : `add ${JSON.stringify(refusal.egressClass)} to projects.constraints[${JSON.stringify(folder)}].allowedEgress to allow it`;
  }
  if (refusal.endpointHost !== undefined) {
    // Not "switch to local": the local provider is the one refused.
    return refusal.endpointHost === null
      ? `fix the URL of provider ${refusal.providerId ?? "(unknown)"}, or remove it from projects.constraints[${JSON.stringify(folder)}].allowedProviders`
      : `add ${JSON.stringify(refusal.endpointHost)} to projects.constraints[${JSON.stringify(folder)}].allowedProviderHosts to allow it`;
  }
  if (opts.localModelConfigured && refusal.allowedProviders.length > 0) {
    return "switch to local with ctrl+r or /runmode local";
  }
  return `edit projects.constraints[${JSON.stringify(folder)}].allowedProviders in config.json to change what this folder may use`;
}

/** The sentence and, indented under it, the hint: what the TUI and CLI print. */
export function formatConstraintRefusal(
  refusal: ConstraintRefusal,
  opts: { readonly localModelConfigured: boolean },
): string {
  return `${refusal.message}\n  ${constraintRefusalHint(refusal, opts)}`;
}

function describeProviderRefusal(err: ProviderNotAllowedError): ConstraintRefusal {
  const policy = err.policy;
  const base = {
    code: PROVIDER_NOT_ALLOWED_CODE,
    folder: policy?.key ?? null,
    allowedProviders: policy === undefined ? [] : [...policy.allowedProviders],
    providerId: err.providerId ?? null,
    egressClass: null,
  } as const;
  if (err.reason === "no-policy" || policy === undefined) {
    return {
      ...base,
      message: `Provider constraints are configured (projects.constraints), but ${err.role} carries no folder policy, so nothing was sent.`,
    };
  }
  const allowed = policy.allowedProviders.length === 0 ? "no provider" : policy.allowedProviders.join(", ");
  const readFrom = policy.readFrom ?? [];
  const head = readFrom.length > 0
    ? `This session read files from ${readFrom.join(", ")}, which ${readFrom.length > 1 ? "are" : "is"} restricted to: ${allowed}.`
    : `This folder is restricted to: ${allowed}.`;
  if (err.reason === "remote-endpoint") {
    const id = err.providerId ?? "this provider";
    const where = err.endpointHost === null || err.endpointHost === undefined
      ? "its endpoint cannot be read"
      : `its endpoint ${err.endpointHost} is another machine`;
    return { ...base, endpointHost: err.endpointHost ?? null, message: `${head} ${id} is allowed, but ${where}, so ${err.role} can't use it here.` };
  }
  const tail = err.reason === "none-allowed"
    ? `No allowed provider can serve ${err.role}.`
    : `${capitalize(err.role)} can't use ${err.providerId ?? "this provider"} here.`;
  return { ...base, message: `${head} ${tail}` };
}

function findEgressRefusal(err: unknown): EgressNotAllowedError | ShellNetworkNotAllowedError | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof EgressNotAllowedError || current instanceof ShellNetworkNotAllowedError) return current;
    if (typeof current !== "object" || current === null) return undefined;
    const next = (current as { cause?: unknown }).cause;
    if (next === current) return undefined;
    current = next;
  }
  return undefined;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/**
 * Whether a local model is configured (a managed model chosen, or an
 * external server), for the hint; false when the config is unreadable.
 * Surfaces without TUI state (sidecar, HTTP) read it here.
 */
export function currentLocalModelConfigured(): boolean {
  try {
    const lm = getConfig().localModels;
    return lm.managed.modelId !== null || lm.mode === "external";
  } catch {
    return false;
  }
}
