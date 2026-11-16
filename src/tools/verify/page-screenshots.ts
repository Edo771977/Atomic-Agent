/**
 * Where a page run's screenshots go and how they are written (issue #40).
 *
 * The caller names the place: a fusion contract check under a run gets
 * `<stateDir>/fusion-runs/<runId>/shots` and its task id as the prefix
 * (`fusionRunShotTarget`), kept with the run's retention so a milestone
 * can show them; anything else gets the temp folder `browser.screenshot`
 * uses. Files are `<prefix>-<n>.jpg`, numbered on from what is there,
 * created exclusively with mode 0600 in a 0700 directory.
 */
import { chmod, mkdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browserShotDir } from "../browser/screenshot.js";

export interface VerifyShotTarget {
  readonly dir: string;
  readonly prefix: string;
}

export interface VerifyScreenshot {
  readonly path: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  /** A full-page shot was cut at the height cap. */
  readonly clipped?: true;
  /** Taken at the end of this game (0-based), when the run played games. */
  readonly game?: number;
}

/** At most this many screenshots per run. */
export const VERIFY_MAX_SCREENSHOTS = 4;
const MAX_NUMBER = 10_000;

function safePrefix(prefix: string): string {
  const safe = prefix.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  return safe.length === 0 || safe === "." || safe === ".." ? "shot" : safe;
}

/** The temp-folder target of a run with no durable place. */
export function defaultShotTarget(now: Date = new Date()): VerifyShotTarget {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1");
  return { dir: browserShotDir(tmpdir(), "verify-run"), prefix: `page-${stamp}-${process.pid}` };
}

/** Write `buffer` as the next `<prefix>-<n>.jpg` in `target.dir`; the path. */
export async function writeShot(target: VerifyShotTarget, buffer: Buffer): Promise<string> {
  await mkdir(target.dir, { recursive: true, mode: 0o700 });
  // An existing folder keeps its mode under mkdir; this one is ours.
  await chmod(target.dir, 0o700).catch(() => {});
  const prefix = safePrefix(target.prefix);
  for (let n = 1; n <= MAX_NUMBER; n += 1) {
    const path = join(target.dir, `${prefix}-${n}.jpg`);
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    try {
      await handle.writeFile(buffer);
    } finally {
      await handle.close();
    }
    return path;
  }
  throw new Error(`no free screenshot name for ${prefix} in ${target.dir}`);
}
