import { ipcMain, shell } from "electron";

import type { AgentClient } from "./agent-client.js";
import { readWholeConfig, rewriteWholeConfig, withConfigLock } from "./agent-cli.js";
import { planAddReviewer, planFollowLegs, readFusionTeam, type FusionTeamAnswer, type TeamShape } from "./fusion-team.js";
import { folderConstraintFor, type FolderConstraint } from "./folder-constraint.js";
import { isSafeSignInUrl } from "./mcp-auth-url.js";
import { readProviderRestriction, type ProviderRestrictionAnswer } from "./provider-restriction.js";
import { isTelegramPairingOp } from "./telegram-pairing.js";

/**
 * Agent routes that act on the RUNNING agent instead of on the file and a
 * restart: live MCP server control and the deep-merge config patch. Both
 * arrived in agent 0.6.6.
 *
 * The one hazard is an older agent. Its `PATCH /api/config` was a shallow
 * merge that rebuilt the file from four blocks and silently dropped the
 * rest (`llm`, `mcp`, `telegram`, ...). So a patch is only sent after
 * `/health` proves the agent is 0.6.6 or newer: `busyTurns` shipped in the
 * same release as the deep merge and is always present on loopback. When
 * the check fails the answer is `{ok:false, unsupported:true}` and the
 * renderer falls back to the CLI write it used before.
 */

/** `MCP_SERVER_NAME_RE` in src/mcp/mcp-types.ts. */
const MCP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

type LiveResult<T> = { ok: true; data: T } | { ok: false; error: string; unsupported?: boolean };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** True when the agent answering is 0.6.6+ (see the note above). */
export async function agentHasLiveRoutes(client: AgentClient): Promise<boolean> {
  try {
    const health = (await client.health()) as { busyTurns?: unknown } | null;
    return typeof health?.busyTurns === "number";
  } catch {
    return false;
  }
}

export function wireAgentLiveIpc(client: AgentClient): void {
  /* The patch queues on the same lock as every CLI config write, so it
     cannot interleave with a whole-file write in flight. */
  ipcMain.handle("agent:configPatch", (_event, patch: unknown): Promise<LiveResult<unknown>> => {
    if (!isPlainObject(patch)) return Promise.resolve({ ok: false, error: "patch must be an object" });
    return withConfigLock(async (): Promise<LiveResult<unknown>> => {
      if (!(await agentHasLiveRoutes(client))) {
        return { ok: false, unsupported: true, error: "this agent cannot merge config live" };
      }
      try {
        return { ok: true, data: await client.patchConfig(patch) };
      } catch (err) {
        return { ok: false, error: message(err) };
      }
    });
  });

  ipcMain.handle("agent:mcpServer", async (_event, payload: unknown): Promise<LiveResult<unknown>> => {
    const { name, op } = (payload ?? {}) as { name?: unknown; op?: unknown };
    if (typeof name !== "string" || !MCP_NAME_RE.test(name)) return { ok: false, error: "server name required" };
    if (op !== "restart" && op !== "enable" && op !== "disable") return { ok: false, error: "op must be restart, enable or disable" };
    const run = async (): Promise<LiveResult<unknown>> => {
      try {
        const res = await client.mcpServer(name, op);
        return { ok: true, data: res ? res.server ?? null : null };
      } catch (err) {
        const text = message(err);
        // An agent older than 0.6.6 has no such route: http-server.ts answers "No route for POST …".
        if (/^No route for /.test(text)) return { ok: false, unsupported: true, error: text };
        return { ok: false, error: text };
      }
    };
    // enable / disable write `enabled` into config.json, so they take the config lock too.
    return op === "restart" ? run() : withConfigLock(run);
  });

  /* MCP browser sign-in (mcp-auth-url.ts, renderer/mcp-auth.js). The agent
     prepares the sign-in and answers the authorization server's page; this
     opens it in the person's browser after checking it is plain https. The
     browser then returns to the agent's own loopback page, never to here.
     No config lock: the agent keeps sign-ins in its own state folder. */
  const authCall = async <T>(name: unknown, call: (n: string) => Promise<T>): Promise<LiveResult<T>> => {
    if (typeof name !== "string" || !MCP_NAME_RE.test(name)) return { ok: false, error: "server name required" };
    try {
      return { ok: true, data: await call(name) };
    } catch (err) {
      const text = message(err);
      if (/^No route for /.test(text)) return { ok: false, unsupported: true, error: text };
      return { ok: false, error: text };
    }
  };
  ipcMain.handle("mcp:authStart", async (_event, name: unknown): Promise<LiveResult<{ state: string }>> => {
    const res = await authCall(name, (n) => client.mcpAuthStart(n));
    if (!res.ok) return res;
    const data = res.data ?? { state: "pending" };
    if (data.state === "signed_in") return { ok: true, data: { state: "signed_in" } };
    if (!isSafeSignInUrl(data.authUrl)) {
      return { ok: false, error: "The sign-in page address is not a plain https link, so it was not opened." };
    }
    try {
      await shell.openExternal(data.authUrl);
    } catch (err) {
      return { ok: false, error: "Could not open your browser: " + message(err) };
    }
    return { ok: true, data: { state: "pending" } };
  });
  ipcMain.handle("mcp:authStatus", (_event, name: unknown) => authCall(name, (n) => client.mcpAuthStatus(n)));
  ipcMain.handle("mcp:authSignOut", (_event, name: unknown) => authCall(name, (n) => client.mcpAuthSignOut(n)));

  /* ATO-859: Telegram pairing (main/telegram-pairing.ts). The agent writes
     the new owner itself when the code is claimed, so this takes no config
     lock. The answer carries the one-time code to the window; nothing here
     logs it. */
  ipcMain.handle("agent:telegramPairing", async (_event, payload: unknown) => {
    const { op, replaceOwner } = (payload ?? {}) as { op?: unknown; replaceOwner?: unknown };
    if (!isTelegramPairingOp(op)) return { ok: false, error: "op must be start, status or cancel" };
    return client.telegramPairing(op, replaceOwner === true);
  });
  // ATO-758: why the bot does not answer, when another poller holds it off.
  ipcMain.handle("agent:telegramChannel", () => client.telegramChannel());
  /* ATO-1094: the grey next-step suggestion for the composer (renderer/next-step.js).
     Read-only, so no config lock; the text goes to the window and nowhere else. */
  ipcMain.handle("agent:nextStep", (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200) return { supported: true, text: null };
    return client.nextStep(sessionId);
  });
  /* Issue #67: the composer's "restricted to: …" chip (renderer/chat-restriction.js).
     Read-only; the folder it names goes to the window and nowhere else. */
  // `remote`: the agent is another computer's, so this window's config.json is not its policy (review of #67).
  // `status`: the route's own (a 404 at a first turn's end is a chat not stored yet; the window asks once more).
  /* Review of #67: the projects.constraints entry a folder falls under, as the
     agent matches it (folder-constraint.ts), for the provisional chip of a chat
     the agent has not answered for. A remote agent's config is not this one. */
  ipcMain.handle("agent:folderConstraint", async (_event, dir: unknown): Promise<{ known: boolean; constraint: FolderConstraint | null }> => {
    if (client.isRemote) return { known: false, constraint: null };
    if (typeof dir !== "string" || !dir || dir.length > 4096) return { known: false, constraint: null };
    const cfg = await readWholeConfig().catch(() => null);
    if (!cfg || !cfg.ok || !cfg.config) return { known: false, constraint: null };
    const constraints = (cfg.config as { projects?: { constraints?: unknown } }).projects?.constraints;
    try {
      return { known: true, constraint: folderConstraintFor(constraints, dir) };
    } catch {
      return { known: false, constraint: null };
    }
  });
  ipcMain.handle("agent:providerRestriction", async (_event, sessionId: unknown): Promise<ProviderRestrictionAnswer & { remote: boolean; status: number | null }> => {
    const remote = client.isRemote;
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200) return { ...readProviderRestriction(null), remote, status: null };
    try {
      const res = await client.sessionRoute(sessionId, "provider-restriction", "GET", undefined, 5_000);
      return { ...readProviderRestriction(res), remote: client.isRemote, status: res.status };
    } catch {
      return { ...readProviderRestriction(null), remote: client.isRemote, status: null };
    }
  });

  /* Issue #71: the Fusion team for the strip's seats (fusion-team.ts). */
  ipcMain.handle("agent:fusionTeam", async (_event, sessionId: unknown): Promise<FusionTeamAnswer> => {
    const sid = typeof sessionId === "string" && sessionId && sessionId.length <= 200 ? sessionId : null;
    try {
      return readFusionTeam(await client.fusionTeam(sid));
    } catch {
      return readFusionTeam(null);
    }
  });
  /* "Add a reviewer…" and a leg moved off the team: planned from the file
     under the config lock, then the team block sent live (PATCH replaces its
     arrays whole), or, on an agent without live writes, the whole file. */
  ipcMain.handle("agent:fusionTeamWrite", async (_event, payload: unknown): Promise<{ ok: boolean; changed?: boolean; live?: boolean; error?: string }> => {
    const p = isPlainObject(payload) ? payload : {};
    const op = p.op;
    if (op !== "addReviewer" && op !== "followLegs") return { ok: false, error: "op must be addReviewer or followLegs" };
    if (op === "addReviewer" && typeof p.ref !== "string") return { ok: false, error: "ref is required" };
    const plan = (cfg: Parameters<typeof planFollowLegs>[0]): { write: boolean; team?: TeamShape; error?: string } =>
      op === "addReviewer" ? planAddReviewer(cfg, p.ref as string) : planFollowLegs(cfg);
    if (await agentHasLiveRoutes(client)) {
      return withConfigLock(async () => {
        const read = await readWholeConfig();
        if (!read.ok || !read.config) return { ok: false, error: read.error ?? "could not read config.json" };
        const verdict = plan(read.config);
        if (verdict.error) return { ok: false, error: verdict.error };
        if (!verdict.write || !verdict.team) return { ok: true, changed: false };
        try {
          await client.patchConfig({ llm: { runMode: { fusion: { team: verdict.team } } } });
          return { ok: true, changed: true, live: true };
        } catch (err) {
          return { ok: false, error: message(err) };
        }
      });
    }
    const res = await rewriteWholeConfig((cfg) => plan(cfg));
    if (res.verdict?.error) return { ok: false, error: res.verdict.error };
    return res.ok ? { ok: true, changed: res.changed, live: false } : { ok: false, error: res.error ?? "config write failed" };
  });
}
