/**
 * Issue #67: the provider restriction on a chat, for the composer's
 * "restricted to: …" chip (renderer/chat-restriction.js). The agent's
 * `GET /api/sessions/{id}/provider-restriction` (issue #33) answers
 * `{ restriction, channelsAllowed }`: `restriction` is `{ label,
 * allowedProviders, folder, readFrom }` (its folder's
 * `projects.constraints` entry, or what it read inside one) or `null`.
 *
 * `known: false` for anything else (no answer, an error, a 404 from an
 * agent without the route or for a chat it has not stored yet, a body of
 * another shape): the window then draws no chip. `channelsAllowed` is
 * `null` from an agent before that field.
 */

export interface ProviderRestrictionView {
  label: string;
  allowedProviders: string[];
  folder: string;
  readFrom: string[];
}

export interface ProviderRestrictionAnswer {
  known: boolean;
  restriction: ProviderRestrictionView | null;
  channelsAllowed: boolean | null;
}

const UNKNOWN: ProviderRestrictionAnswer = { known: false, restriction: null, channelsAllowed: null };
const TEXT_MAX = 1000;
const LIST_MAX = 32;

function strings(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return null;
  return value.slice(0, LIST_MAX).map((v: string) => v.slice(0, TEXT_MAX));
}

export function readProviderRestriction(answer: { status: number; body: unknown } | null): ProviderRestrictionAnswer {
  if (!answer || answer.status !== 200) return UNKNOWN;
  const body = answer.body && typeof answer.body === "object" ? (answer.body as Record<string, unknown>) : null;
  if (!body || !("restriction" in body)) return UNKNOWN;
  const channelsAllowed = typeof body.channelsAllowed === "boolean" ? body.channelsAllowed : null;
  if (body.restriction === null) return { known: true, restriction: null, channelsAllowed };
  const r = body.restriction && typeof body.restriction === "object" ? (body.restriction as Record<string, unknown>) : null;
  const allowedProviders = strings(r?.allowedProviders);
  const readFrom = r?.readFrom === undefined ? [] : strings(r.readFrom);
  if (!r || typeof r.label !== "string" || typeof r.folder !== "string" || !allowedProviders || !readFrom) return UNKNOWN;
  return {
    known: true,
    restriction: { label: r.label.slice(0, TEXT_MAX), allowedProviders, folder: r.folder.slice(0, TEXT_MAX), readFrom },
    channelsAllowed,
  };
}
