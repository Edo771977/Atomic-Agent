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
 * creating the team from the two legs when there is none, so nothing else
 * changes; a leg moved to a model the team does not list is added to its
 * directors or workers ({@link planFollowLegs}). A team member names a
 * model; the model `default` is the entry's own, for an entry that names
 * none (a Codex subscription on the ChatGPT account's default).
 */

export const NO_REVIEW = "none";
/** `TEAM_MEMBER_PROVIDER_MODEL` in src/config/llm-fusion-team-config.ts. */
export const PROVIDER_MODEL = "default";

export interface TeamMemberView {
  ref: string;
  providerId: string;
  model: string;
  usable: boolean;
  reason?: "folder" | "unreachable";
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

interface ConfigLike {
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
      ...(m.reason === "folder" || m.reason === "unreachable" ? { reason: m.reason } : {}),
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

/** The team choice the window sends with a turn: only the reviewer (a member ref, or "none"). */
export function teamChoiceFromWindow(raw: unknown): { reviewer?: string } {
  if (!isObject(raw)) return {};
  const r = raw.reviewer;
  if (r === NO_REVIEW) return { reviewer: NO_REVIEW };
  return splitRef(r) === null ? {} : { reviewer: r as string };
}

function fusionOf(cfg: ConfigLike): FusionLike | undefined {
  return cfg.llm?.runMode?.fusion;
}

/** A leg's member ref: its provider and model, `default` when the entry names none. */
export function legRef(cfg: ConfigLike, leg: "orchestrator" | "worker"): string | null {
  const fusion = fusionOf(cfg);
  const id = leg === "orchestrator" ? fusion?.orchestratorProvider : fusion?.workerProvider;
  if (!id) return null;
  const entry = (cfg.llm?.providers ?? []).find((p) => p && p.id === id);
  if (!entry) return null;
  const pinned = leg === "orchestrator" ? fusion?.orchestratorModel : fusion?.workerModel;
  const model = pinned || entry.defaultChatModel || entry.model || PROVIDER_MODEL;
  return `${id}:${model}`;
}

function cloneTeam(team: TeamShape): TeamShape {
  return JSON.parse(JSON.stringify(team)) as TeamShape;
}

/**
 * Add `ref` to the team's reviewers. No team: one made from the two legs
 * (`directors: [orchestrator leg]`, `workers: [worker leg]`), so the seats
 * run as before. Mutates `cfg` (for a whole-file write) and returns the team.
 * `review` is left as it is: listed reviewers turn review on unless it is
 * "off", and a chat that chooses its reviewer has review whatever it says.
 */
export function planAddReviewer(cfg: ConfigLike, ref: string): { write: boolean; team?: TeamShape; error?: string } {
  const split = splitRef(ref);
  if (split === null) return { write: false, error: 'a reviewer is "<providerId>:<model>"' };
  if (!(cfg.llm?.providers ?? []).some((p) => p && p.id === split.providerId)) {
    return { write: false, error: `${split.providerId} is not a configured provider` };
  }
  const fusion = fusionOf(cfg);
  if (!fusion) return { write: false, error: "Fusion is not set up" };
  let team: TeamShape;
  if (fusion.team) team = cloneTeam(fusion.team);
  else {
    const director = legRef(cfg, "orchestrator");
    const worker = legRef(cfg, "worker");
    if (director === null) return { write: false, error: "the orchestrator seat has no provider" };
    team = { directors: [director], ...(worker === null ? {} : { workers: [worker] }) };
  }
  const reviewers = team.reviewers ?? [];
  if (reviewers.includes(ref)) return { write: false, team };
  team.reviewers = [...reviewers, ref];
  fusion.team = team;
  return { write: true, team };
}

/** Put each leg's member at the front of the team's directors / workers when it is missing. */
export function planFollowLegs(cfg: ConfigLike): { write: boolean; team?: TeamShape } {
  const fusion = fusionOf(cfg);
  if (!fusion?.team) return { write: false };
  const team = cloneTeam(fusion.team);
  let write = false;
  const director = legRef(cfg, "orchestrator");
  if (director !== null && !team.directors.includes(director)) {
    team.directors = [director, ...team.directors];
    write = true;
  }
  const worker = legRef(cfg, "worker");
  if (worker !== null && team.workers !== undefined && !team.workers.includes(worker)) {
    team.workers = [worker, ...team.workers];
    write = true;
  }
  if (write) fusion.team = team;
  return { write, team };
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
