import { ipcMain } from "electron";

import { atagRun, configGetKey, plainCliError, withConfigLock, type CliResult } from "./agent-cli.js";
import { readDotenvValue } from "./composio-key.js";
import { DESKTOP_STATE_DIR } from "./state-dir.js";
import {
  isUnsupportedPushCli,
  parsePushOp,
  parsePushState,
  pushCliArgs,
  pushOpWritesConfig,
  turnPushRequest,
  type PushState,
} from "./push-cli.js";
import { answerLacksChannelsField, turnPushNote, type TurnEnd } from "./turn-notify.js";

let saidNoChannelsField = false;

/**
 * Settings › Connections › Phone push (ATO-1129). Two routes, both
 * through the bundled agent (push-cli.ts says why):
 *
 *   cli:pushStatus → `atag config get notifications.push`
 *   cli:pushSet    → `atag push on|off|test` (`on --new-topic` for a new topic)
 *
 * Every answer is `{ok: true, ...}` or `{ok: false, error, unsupported?}`;
 * nothing throws at the window.
 */

const UNSUPPORTED = "This agent has no phone push yet. Update Atomic Agent to set it up here.";

type Failure = { ok: false; error: string; unsupported?: boolean };

function failure(res: CliResult): Failure {
  if (isUnsupportedPushCli(`${res.stderr}\n${res.error ?? ""}`)) return { ok: false, unsupported: true, error: UNSUPPORTED };
  return { ok: false, error: plainCliError(res.stderr) || res.error || "the agent did not answer" };
}

export async function pushStatus(): Promise<{ ok: true; push: PushState } | Failure> {
  const res = await configGetKey("notifications.push");
  if (!res.ok) return { ok: false, error: res.error ?? "could not read the setting" };
  const push = parsePushState(res.value);
  return push ? { ok: true, push } : { ok: false, unsupported: true, error: UNSUPPORTED };
}

/**
 * A desktop turn ended while nobody was looking (turn-notify.ts): send a
 * note to the phone when push is on. The phone is off this machine, so the
 * chat's folder constraint decides first (issue #33): `restriction` asks
 * the agent (`GET /api/sessions/{id}/provider-restriction`) and
 * turnPushNote sends nothing for a restricted chat whose allowedEgress
 * lacks "channels", never the error text of a restricted one, and nothing
 * at all when the answer cannot be had (fail closed). One attempt, 8 s,
 * never throws.
 */
export async function pushTurnNote(
  turn: TurnEnd,
  restriction: (sessionId: string) => Promise<{ status: number; body: unknown }>,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const st = await pushStatus();
    if (!st.ok || !st.push.enabled || !turn.sessionId) return false;
    let answer: { status: number; body: unknown } | null = null;
    try {
      answer = await restriction(turn.sessionId);
    } catch {
      answer = null;
    }
    if (!saidNoChannelsField && answerLacksChannelsField(answer)) {
      saidNoChannelsField = true;
      console.warn("[desktop] phone push: the agent does not say whether a chat may reach a channel (older agent); restricted chats are not pushed");
    }
    const note = turnPushNote(turn, answer);
    if (!note) return false;
    const req = turnPushRequest(st.push, note, readDotenvValue(DESKTOP_STATE_DIR, st.push.tokenEnv));
    if (!req) return false;
    const res = await fetchImpl(req.url, { ...req.init, signal: AbortSignal.timeout(8_000) });
    return res.ok;
  } catch {
    return false;
  }
}

export function wirePushIpc(): void {
  ipcMain.handle("cli:pushStatus", () => pushStatus());

  ipcMain.handle("cli:pushSet", async (_event, raw: unknown) => {
    const op = parsePushOp(raw);
    if (!op) return { ok: false, error: "unknown push operation" };
    const go = () => atagRun(pushCliArgs(op), 30_000);
    const res = pushOpWritesConfig(op) ? await withConfigLock(go) : await go();
    if (!res.ok) return failure(res);
    const after = await pushStatus();
    return { ok: true, message: res.stdout.trim(), ...(after.ok ? { push: after.push } : {}) };
  });
}
