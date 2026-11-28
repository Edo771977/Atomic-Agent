// o1: "the agent runs ON this computer" (ATO-1723, user bug ATO-1706).
// On the 2B starter model the agent answered a RAM question with "I have no
// access to your hardware" and pointed at the cloud, although it has a shell
// on the very machine. The answer is the chat reply (stdout of `run`), not a
// file produced by a model. This fork uses a fictional computer described by
// computer.json in the temporary workspace, never the operator's hardware.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { fail, pass } from "../lib/util.mjs";

const GIB = 1024 ** 3;
const GB = 1e9;
export const SYNTHETIC_RAM_BYTES = 16 * GIB;

/** Phrases of the ATO-1706 refusal; any one fails the run even with the right number. */
export const REFUSAL_PHRASES = ["no access", "cannot access", "don't have access", "cloud"];

/** Numbers in a reply, dots as decimal marks ("16", "15.5"). Thousands commas split into parts. */
export function replyNumbers(text) {
  return (String(text).match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter(Number.isFinite);
}

/**
 * Deterministic verdict for a RAM reply. `totalBytes` is the machine's RAM in
 * bytes; both GiB (16 GiB) and decimal GB (17.2 GB) readings are accepted, +-1.
 */
export function checkRamReply(text, totalBytes) {
  const reply = String(text ?? "").replace(/[‘’]/g, "'").trim();
  if (!reply) return fail("no reply");
  const lower = reply.toLowerCase();
  const refusal = REFUSAL_PHRASES.find((p) => lower.includes(p));
  if (refusal) return fail(`reply says '${refusal}'`);
  const gib = totalBytes / GIB;
  const gb = totalBytes / GB;
  const numbers = replyNumbers(reply);
  const hit = numbers.some((n) => Math.abs(n - gib) <= 1 || Math.abs(n - gb) <= 1);
  if (hit) return pass();
  return fail(`no RAM size near ${gib.toFixed(1)} GiB / ${gb.toFixed(1)} GB in reply '${reply.slice(0, 60)}'`);
}

const o1 = {
  id: "o1",
  set: "core",
  title: "answer about a fictional computer's RAM from its workspace fixture (ATO-1706)",
  timeoutSec: 300,
  maxSteps: 10,
  turns: () => ["The fictional computer for this task is described by computer.json in this workspace. How much RAM does it have? Read only that workspace file, not host hardware or files outside this workspace. Answer with the number in GB."],
  fixture(dir) {
    writeFileSync(join(dir, "computer.json"), JSON.stringify({ totalBytes: SYNTHETIC_RAM_BYTES }) + "\n");
    return { totalBytesAtFixture: SYNTHETIC_RAM_BYTES };
  },
  check(_dir, _meta, ctx = {}) {
    return checkRamReply(ctx.run?.stdout, SYNTHETIC_RAM_BYTES);
  },
  /** Reference reply. The answer is chat text, so it goes into ctx.run.stdout, not the folder. */
  solve(_dir, _meta, ctx) {
    const gib = Math.round(SYNTHETIC_RAM_BYTES / GIB);
    ctx.run = { ...(ctx.run ?? {}), stdout: `This computer has ${gib} GB of RAM.\n` };
  },
};

export default [o1];
