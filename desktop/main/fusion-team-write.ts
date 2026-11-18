/**
 * Issue #71/#74: "Add a reviewer…" and a leg moved off the team
 * (`agent:fusionTeamWrite`, agent-live.ts), as a function of its
 * dependencies so the suite drives it without Electron.
 *
 * The plan is made from the file (fusion-team.ts) and the legs bookkeeping
 * file, both read INSIDE one hold of the config lock. Then:
 *   - on an agent with live writes, the team block goes out as a PATCH (it
 *     replaces the arrays whole, and the running agent sees it at once). The
 *     PATCH route takes no expected hash, so the hash the plan was made on is
 *     checked again right before it is sent: a file that moved in between
 *     (the terminal agent, another window) is read and planned again, up to
 *     `tries` times, and then the calm "changed somewhere else" sentence is
 *     the answer. An agent that gives no hash is written the old way.
 *   - otherwise the whole file through rewriteWholeConfig, which is already a
 *     compare-and-swap (`--expect-sha256` / `PUT … expectSha256`).
 */

import { planAddReviewer, planFollowLegs, type ConfigLike, type LegMembers, type TeamShape } from "./fusion-team.js";

export type FusionTeamWriteResult = { ok: boolean; changed?: boolean; live?: boolean; error?: string };
type Verdict = { write: boolean; team?: TeamShape; legs?: LegMembers; error?: string };

export interface FusionTeamWriteDeps {
  /** The agent answering takes live config patches (agentHasLiveRoutes). */
  live: () => Promise<boolean>;
  /** One hold of the desktop's config lock (agent-cli withConfigLock). */
  withLock: <T>(hold: () => Promise<T>) => Promise<T>;
  /** The file and the sha256 of the bytes it was parsed from (agent-cli readConfigWithSha); sha null when unknown. */
  readWithSha: () => Promise<{ ok: boolean; config?: unknown; sha256: string | null; error?: string }>;
  /** `PATCH /api/config` with the team block. */
  patchTeam: (team: TeamShape) => Promise<unknown>;
  /** The whole-file compare-and-swap write (agent-cli rewriteWholeConfig). */
  rewrite: (plan: (cfg: ConfigLike) => Verdict) => Promise<{ ok: boolean; changed: boolean; error?: string; verdict?: Verdict }>;
  /** fusion-team.ts readLegMembers / writeLegMembers on the desktop state dir. */
  readLegs: () => LegMembers;
  writeLegs: (legs: LegMembers) => void;
  /** Said when the file kept moving under every try (agent-cli CONFIG_CHANGED_ELSEWHERE). */
  changedElsewhere: string;
  /** How many read-plan-check rounds one live write may take (default 3). */
  tries?: number;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function writeFusionTeam(payload: unknown, deps: FusionTeamWriteDeps): Promise<FusionTeamWriteResult> {
  const p = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const op = p.op;
  if (op !== "addReviewer" && op !== "followLegs") return { ok: false, error: "op must be addReviewer or followLegs" };
  if (op === "addReviewer" && typeof p.ref !== "string") return { ok: false, error: "ref is required" };
  // Read inside the hold, with the plan: which member the desktop last wrote for each seat.
  let last: LegMembers = {};
  const plan = (cfg: ConfigLike): Verdict => {
    last = deps.readLegs();
    return op === "addReviewer" ? planAddReviewer(cfg, p.ref as string) : planFollowLegs(cfg, last);
  };
  const remember = (legs: LegMembers | undefined): void => {
    if (legs !== undefined) deps.writeLegs({ ...last, ...legs });
  };

  if (await deps.live()) {
    return deps.withLock(async (): Promise<FusionTeamWriteResult> => {
      const tries = Math.max(1, deps.tries ?? 3);
      for (let attempt = 1; attempt <= tries; attempt++) {
        const read = await deps.readWithSha();
        if (!read.ok || !read.config || typeof read.config !== "object") return { ok: false, error: read.error ?? "could not read config.json" };
        const verdict = plan(read.config as ConfigLike);
        if (verdict.error) return { ok: false, error: verdict.error };
        if (!verdict.write || !verdict.team) return { ok: true, changed: false };
        if (read.sha256 !== null) {
          const again = await deps.readWithSha();
          if (!again.ok) return { ok: false, error: again.error ?? "could not read config.json" };
          // Moved since the plan was made: plan again on what is there now.
          if (again.sha256 !== read.sha256) continue;
        }
        try {
          await deps.patchTeam(verdict.team);
          remember(verdict.legs);
          return { ok: true, changed: true, live: true };
        } catch (err) {
          return { ok: false, error: message(err) };
        }
      }
      return { ok: false, error: deps.changedElsewhere };
    });
  }
  const res = await deps.rewrite(plan);
  if (res.verdict?.error) return { ok: false, error: res.verdict.error };
  if (res.ok && res.changed) remember(res.verdict?.legs);
  return res.ok ? { ok: true, changed: res.changed, live: false } : { ok: false, error: res.error ?? "config write failed" };
}
