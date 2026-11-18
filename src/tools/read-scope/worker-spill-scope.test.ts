import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { compressToolResult } from "../../compressor/result-compressor.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { FULL_OUTPUT_PATH_DETAIL, ToolOutputSpill } from "../tool-output-spill.js";
import { findSessionReadOutside, findShellPathOutsideScope, sessionReadRoots } from "./index.js";

/**
 * Review of issue #74: a Fusion worker's summary hands its orchestrator
 * the path of the worker's saved output; the orchestrator (and its own
 * orchestrator) reads it as its own, unasked. Any other session asks.
 */
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const long = compressToolResult(
  { tool: "os.shell.run", status: "ok", output: "x\n".repeat(5000), details: {} },
  { maxSummaryLength: 100 },
);

describe("a fusion worker's spill folder", () => {
  it("is its orchestrators' own, and foreign to anyone else", async () => {
    const tag = `${process.pid}-${Date.now()}`;
    const worker = `${FUSION_WORKER_ID_PREFIX}${tag}`;
    const parents: Record<string, string[]> = { [worker]: [`s-orch-${tag}`, `s-top-${tag}`] };
    const spill = new ToolOutputSpill({ parentsFor: (id) => parents[id] ?? [] });
    made.push(spill.dirFor(worker));
    const out = await spill.spill("os.shell.run", worker, long);
    const file = out.details[FULL_OUTPUT_PATH_DETAIL] as string;
    expect(typeof file).toBe("string");
    const ctx = (sessionId: string) => ({ sessionId, workingDir: "/srv/me/project" });
    const fsRead = (sessionId: string) =>
      findSessionReadOutside("os.fs.read", { path: file }, ctx(sessionId), sessionReadRoots(ctx(sessionId)));
    const shell = (sessionId: string) =>
      findShellPathOutsideScope({ cmd: "cat", args: [file] }, ctx(sessionId), sessionReadRoots(ctx(sessionId)));
    for (const id of [`s-orch-${tag}`, `s-top-${tag}`]) {
      expect(fsRead(id), id).toBeNull();
      expect(shell(id), id).toBeNull();
    }
    expect(fsRead(`s-stranger-${tag}`)).toBe(file);
    expect(shell(`s-stranger-${tag}`)).toBe(file);
  });
});
