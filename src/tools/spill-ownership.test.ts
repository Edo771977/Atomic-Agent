import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { compressToolResult } from "../compressor/result-compressor.js";
import { makeProviderPolicy } from "../config/project-constraint-match.js";
import { findSessionReadOutside, sessionReadRoots, tempCopyPolicy } from "./read-scope/index.js";
import { FULL_OUTPUT_PATH_DETAIL, ToolOutputSpill } from "./tool-output-spill.js";

/**
 * Review of issue #74: a spill folder belongs to the session its marker
 * names, never to whichever session's id maps to the same folder name.
 */
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tag = `${process.pid}-${Date.now()}`;
const secret = makeProviderPolicy({ key: "/work/secret", allowedProviders: ["local-llama"], matchedDir: "/work/secret" });
const long = compressToolResult(
  { tool: "os.shell.run", status: "ok", output: "x\n".repeat(5000), details: {} },
  { maxSummaryLength: 100 },
);
const read = (path: string, sessionId: string) => {
  const ctx = { sessionId, workingDir: "/srv/me/project" };
  return findSessionReadOutside("os.fs.read", { path }, ctx, sessionReadRoots(ctx));
};

describe("spill folder ownership", () => {
  it("two ids that used to share a folder name get separate folders", async () => {
    const a = `codex:a.b-${tag}`;
    const b = `codex:a_b-${tag}`;
    const spill = new ToolOutputSpill({ policyFor: (id) => (id === a ? secret : undefined) });
    made.push(spill.dirFor(a), spill.dirFor(b));
    expect(spill.dirFor(a)).not.toBe(spill.dirFor(b));
    const out = await spill.spill("os.shell.run", a, long);
    const file = out.details[FULL_OUTPUT_PATH_DETAIL] as string;
    expect(read(file, b)).toBe(file);
    expect(tempCopyPolicy(file, { projects: {} }, { sessionId: b })?.key).toBe("/work/secret");
    spill.removeSession(b);
    expect(existsSync(file)).toBe(true);
  });

  it("an older folder is owned only through a marker naming the session", async () => {
    // The lossy name an older build gave `codex:x.y`, which is also the
    // plain id `codex_x_y`'s folder name.
    const plain = `codex_x_y-${tag}`;
    const spill = new ToolOutputSpill();
    const dir = spill.dirFor(plain);
    made.push(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "0001-abcdef-os-shell-run.txt"), "someone else's output");
    // No marker: foreign, even to the session whose name matches.
    expect(read(join(dir, "0001-abcdef-os-shell-run.txt"), plain)).toBe(join(dir, "0001-abcdef-os-shell-run.txt"));
    // Nor does this session adopt it: no spill, no marker written, nothing removed.
    const out = await spill.spill("os.shell.run", plain, long);
    expect(out.details[FULL_OUTPUT_PATH_DETAIL]).toBeUndefined();
    expect(existsSync(join(dir, ".atag-source.json"))).toBe(false);
    spill.removeSession(plain);
    expect(readFileSync(join(dir, "0001-abcdef-os-shell-run.txt"), "utf8")).toBe("someone else's output");
    // A marker naming another session: foreign too.
    writeFileSync(join(dir, ".atag-source.json"), JSON.stringify({ version: 1, kind: "spill", sessionId: "codex:x.y" }), { mode: 0o600 });
    expect(read(join(dir, "0001-abcdef-os-shell-run.txt"), plain)).toBe(join(dir, "0001-abcdef-os-shell-run.txt"));
    expect(tempCopyPolicy(join(dir, "f"), { projects: {} }, { sessionId: plain })).toBeUndefined();
    expect(existsSync(join(tmpdir(), "atomic-agent-tool-outputs"))).toBe(true);
  });
});
