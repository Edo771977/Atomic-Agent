/**
 * Issue #71: the Fusion team (`llm.runMode.fusion.team`) for the strip's
 * Director / Worker / Reviewer seats (renderer/fusion-reviewer.js).
 *
 * The agent lists the team with what can serve a chat
 * (`GET /api/fusion/team?session=`), read here by {@link readFusionTeam}.
 * The Director and Worker seats stay the two legs (`orchestratorProvider`
 * / `workerProvider`): a turn names their members (`director` / `worker`)
 * when the team lists them and the chat's folder allows them
 * ({@link turnTeamFields}), so what the seats show is what leads. The
 * Reviewer seat's choice (a team reviewer, or `"none"`) rides on the
 * chat's next turn as `reviewer`; the agent stamps it and keeps it.
 *
 * "Add a reviewer…" writes `team.reviewers` ({@link planAddReviewer}),
 * creating the team from the Director seat alone when there is none (no
 * `workers`, and `review: "off"` so only chats that pick a reviewer are
 * reviewed); a seat moved to a model the team does not list replaces the
 * member the desktop wrote for it ({@link planFollowLegs}). A team member
 * names a model; `default` is a subscription CLI entry's own model (a
 * Codex subscription on the ChatGPT account's default) and nothing else's.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const NO_REVIEW = "none";
/** `TEAM_MEMBER_PROVIDER_MODEL` in src/config/llm-fusion-team-config.ts. */
export const PROVIDER_MODEL = "default";

export interface TeamMemberView {
  ref: string;
  providerId: string;
  model: string;
  usable: boolean;
  reason?: "folder" | "unreachable" | "cli-tools";
  why?: string;
}

export interface FusionTeamAnswer {
  known: boolean;
  configured: boolean;
  directors: TeamMemberView[];
  workers: TeamMemberView[];
  reviewers: TeamMemberView[];
  review: "on" | "off" | null;
  /** The chat's stamped choices; null without `?session=` or a team. */
  chat: { director: string | null; worker: string | null; reviewer: string | null } | null;
}

export interface TeamShape {
  directors: string[];
  workers?: string[];
  reviewers?: string[];
  [key: string]: unknown;
}

interface ProviderLike {
  id?: string;
  kind?: string;
  defaultChatModel?: string;
  model?: string;
}

interface FusionLike {
  orchestratorProvider?: string;
  orchestratorModel?: string;
  workerProvider?: string;
  workerModel?: string;
  team?: TeamShape;
}

export interface ConfigLike {
  llm?: { providers?: ProviderLike[]; runMode?: { mode?: string; fusion?: FusionLike } };
}

const UNKNOWN: FusionTeamAnswer = { known: false, configured: false, directors: [], workers: [], reviewers: [], review: null, chat: null };
const TEXT_MAX = 1000;
const LIST_MAX = 64;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A member ref (`"<providerId>:<model>"`, both halves non-blank), or null. */
export function splitRef(ref: unknown): { providerId: string; model: string } | null {
  if (typeof ref !== "string" || ref.length > TEXT_MAX || /[\r\n\0]/.test(ref)) return null;
  const at = ref.indexOf(":");
  if (at <= 0) return null;
  const providerId = ref.slice(0, at);
  const model = ref.slice(at + 1);
  return providerId.trim() && model.trim() ? { providerId, model } : null;
}

function readMembers(raw: unknown): TeamMemberView[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TeamMemberView[] = [];
  for (const m of raw.slice(0, LIST_MAX)) {
    if (!isObject(m) || typeof m.usable !== "boolean") return null;
    const split = splitRef(m.ref);
    if (split === null) return null;
    out.push({
      ref: m.ref as string,
      ...split,
      usable: m.usable,
      ...(m.reason === "folder" || m.reason === "unreachable" || m.reason === "cli-tools" ? { reason: m.reason } : {}),
      ...(typeof m.why === "string" ? { why: m.why.slice(0, TEXT_MAX) } : {}),
    });
  }
  return out;
}

const refOrNull = (v: unknown): string | null => (typeof v === "string" && v.length <= TEXT_MAX ? v : null);

/** The agent's `GET /api/fusion/team` answer; `known: false` for an older agent, an error or another shape. */
export function readFusionTeam(answer: { status: number; body: unknown } | null): FusionTeamAnswer {
  if (!answer || answer.status !== 200 || !isObject(answer.body)) return UNKNOWN;
  const b = answer.body;
  if (typeof b.configured !== "boolean") return UNKNOWN;
  const directors = readMembers(b.directors);
  const workers = readMembers(b.workers);
  const reviewers = readMembers(b.reviewers);
  if (!directors || !workers || !reviewers) return UNKNOWN;
  const chat = isObject(b.chat)
    ? { director: refOrNull(b.chat.director), worker: refOrNull(b.chat.worker), reviewer: refOrNull(b.chat.reviewer) }
    : null;
  return {
    known: true,
    configured: b.configured,
    directors,
    workers,
    reviewers,
    review: b.review === "on" || b.review === "off" ? b.review : null,
    chat,
  };
}

/** Sent as `reviewer` to clear the chat's choice, so the team picks again. */
export const TEAM_PICKS = "team";
/** The most members the desktop lets a role grow to when a seat moves. */
export const ROLE_MAX = 8;

/** The team choice the window sends with a turn: only the reviewer (a member ref, "none" or "team"). */
export function teamChoiceFromWindow(raw: unknown): { reviewer?: string } {
  if (!isObject(raw)) return {};
  const r = raw.reviewer;
  if (r === NO_REVIEW || r === TEAM_PICKS) return { reviewer: r };
  return splitRef(r) === null ? {} : { reviewer: r as string };
}

function fusionOf(cfg: ConfigLike): FusionLike | undefined {
  return cfg.llm?.runMode?.fusion;
}

const SUBSCRIPTION_CLI = "subscription-cli";

/**
 * An entry's member model when nothing pins one: its own model; `default`
 * on a subscription CLI that names none (the account's default); the
 * provider id for a local server (it serves one model, never pinned);
 * null for an API entry with none, which must name one: it is priced and
 * tiered by that model.
 */
function entryModel(entry: ProviderLike, pinned: string | undefined): string | null {
  const own = pinned || entry.defaultChatModel || entry.model;
  if (own) return own;
  if (entry.kind === SUBSCRIPTION_CLI) return PROVIDER_MODEL;
  if (entry.kind === "llama-server") return entry.id ?? null;
  return null;
}

/** A leg's member ref, or null when the leg has no provider or an API leg names no model. */
export function legRef(cfg: ConfigLike, leg: "orchestrator" | "worker"): string | null {
  const fusion = fusionOf(cfg);
  const id = leg === "orchestrator" ? fusion?.orchestratorProvider : fusion?.workerProvider;
  if (!id) return null;
  const entry = (cfg.llm?.providers ?? []).find((p) => p && p.id === id);
  if (!entry) return null;
  const model = entryModel(entry, leg === "orchestrator" ? fusion?.orchestratorModel : fusion?.workerModel);
  return model === null ? null : `${id}:${model}`;
}

/** Which member the desktop last wrote for each seat (kept by main, so a moved seat replaces it). */
export interface LegMembers {
  director?: string;
  worker?: string;
}

function cloneTeam(team: TeamShape): TeamShape {
  return JSON.parse(JSON.stringify(team)) as TeamShape;
}

/**
 * Add `ref` to the team's reviewers. No team: one made of the director
 * seat alone (`directors: [orchestrator leg]`) and the reviewer, without
 * `workers`, so the worker leg, `fusion.roles` and measured routing run as
 * before. The first reviewer of a team whose `review` is not "on" also
 * writes `review: "off"`: listing reviewers would otherwise turn review on
 * for every chat, and only a chat that picks a reviewer should pay for it
 * (a chat's chosen reviewer reviews whatever `review` says). Mutates
 * `cfg` (for a whole-file write) and returns the team, and `legs`: the
 * member written for the director seat, when one was.
 */
export function planAddReviewer(cfg: ConfigLike, ref: string): { write: boolean; team?: TeamShape; legs?: LegMembers; error?: string } {
  const split = splitRef(ref);
  if (split === null) return { write: false, error: 'a reviewer is "<providerId>:<model>"' };
  const entry = (cfg.llm?.providers ?? []).find((p) => p && p.id === split.providerId);
  if (!entry) return { write: false, error: `${split.providerId} is not a configured provider` };
  if (split.model === PROVIDER_MODEL && entry.kind !== SUBSCRIPTION_CLI) {
    return { write: false, error: `${split.providerId} needs a model: name a model for it in Settings › Models` };
  }
  const fusion = fusionOf(cfg);
  if (!fusion) return { write: false, error: "Fusion is not set up" };
  let team: TeamShape;
  let legs: LegMembers | undefined;
  if (fusion.team) team = cloneTeam(fusion.team);
  else {
    const director = legRef(cfg, "orchestrator");
    if (director === null) {
      return { write: false, error: "pick a model for the Director seat first: the team names each member's model" };
    }
    team = { directors: [director] };
    legs = { director };
  }
  const reviewers = team.reviewers ?? [];
  if (reviewers.includes(ref)) return { write: false, team };
  if (reviewers.length === 0 && team.review !== "on") team.review = "off";
  team.reviewers = [...reviewers, ref];
  fusion.team = team;
  return { write: true, team, ...(legs === undefined ? {} : { legs }) };
}

/**
 * A moved seat's member in the team: it replaces, in place, the member
 * the desktop last wrote for that seat (`last`); when the person removed
 * that one by hand, the current leg alone is added, at the end, and never
 * past {@link ROLE_MAX}. A team without `workers` stays without.
 */
export function planFollowLegs(cfg: ConfigLike, last: LegMembers = {}): { write: boolean; team?: TeamShape; legs: LegMembers } {
  const fusion = fusionOf(cfg);
  if (!fusion?.team) return { write: false, legs: last };
  const team = cloneTeam(fusion.team);
  const legs: LegMembers = { ...last };
  let write = false;
  const follow = (list: string[], seat: "director" | "worker", current: string | null): string[] => {
    if (current === null || list.includes(current)) return list;
    const previous = last[seat];
    const at = previous === undefined ? -1 : list.indexOf(previous);
    if (at >= 0) {
      write = true;
      legs[seat] = current;
      return list.map((m, n) => (n === at ? current : m));
    }
    if (list.length >= ROLE_MAX) return list;
    write = true;
    legs[seat] = current;
    return [...list, current];
  };
  team.directors = follow(team.directors, "director", legRef(cfg, "orchestrator"));
  if (team.workers !== undefined) team.workers = follow(team.workers, "worker", legRef(cfg, "worker"));
  if (write) fusion.team = team;
  return { write, team, legs };
}

/**
 * The team fields of one turn: the legs' members while the team lists them
 * and the chat can use them (`roster`, the agent's answer for the chat), and
 * the chat's reviewer choice. Nothing outside Fusion or without a team, so a
 * setup without one runs as before.
 */
export function turnTeamFields(
  cfg: ConfigLike,
  roster: FusionTeamAnswer | null,
  reviewer: string | undefined,
): { director?: string; worker?: string; reviewer?: string } {
  const fusion = fusionOf(cfg);
  if (cfg.llm?.runMode?.mode !== "fusion" || !fusion?.team) return {};
  const usable = (list: TeamMemberView[] | undefined, ref: string | null): ref is string =>
    ref !== null && !!list?.some((m) => m.ref === ref && m.usable);
  const director = legRef(cfg, "orchestrator");
  const worker = legRef(cfg, "worker");
  return {
    ...(usable(roster?.directors, director) ? { director } : {}),
    ...(usable(roster?.workers, worker) ? { worker } : {}),
    ...(reviewer === undefined ? {} : { reviewer }),
  };
}

/** `chat`'s body fields for the team choice. */
export function teamBodyFields(team: { director?: string; worker?: string; reviewer?: string } | undefined): Record<string, string> {
  if (!team) return {};
  return {
    ...(team.director ? { director: team.director } : {}),
    ...(team.worker ? { worker: team.worker } : {}),
    ...(team.reviewer ? { reviewer: team.reviewer } : {}),
  };
}

const LEGS_FILE = "fusion-team-legs.json";

/** The members the desktop last wrote for the seats (`<desktop state>/fusion-team-legs.json`); {} when none. */
export function readLegMembers(dir: string): LegMembers {
  try {
    const raw = JSON.parse(readFileSync(join(dir, LEGS_FILE), "utf8")) as unknown;
    if (!isObject(raw)) return {};
    return {
      ...(splitRef(raw.director) ? { director: raw.director as string } : {}),
      ...(splitRef(raw.worker) ? { worker: raw.worker as string } : {}),
    };
  } catch {
    return {};
  }
}

export function writeLegMembers(dir: string, legs: LegMembers): void {
  try {
    writeFileSync(join(dir, LEGS_FILE), JSON.stringify(legs), "utf8");
  } catch {
    /* bookkeeping only: a moved seat is then appended instead of replaced */
  }
}
