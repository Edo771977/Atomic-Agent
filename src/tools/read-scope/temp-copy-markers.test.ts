import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { compressToolResult } from "../../compressor/result-compressor.js";
import { makeProviderPolicy } from "../../config/project-constraint-match.js";
import { createBranchSet } from "../fusion/branch-workspace.js";
import { ToolOutputSpill } from "../tool-output-spill.js";
import { createVerifyWorkspace } from "../verify/verify-workspace-copy.js";
import {
  isForeignTempCopy,
  isTempCopyMarkerPath,
  readTempCopyMarkerAt,
  TEMP_COPY_MARKER,
  tempCopyPolicy,
} from "./temp-copy-sources.js";

/** Issue #74 item 2: every temp root the runtime makes names its source in a marker. */
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const secret = makeProviderPolicy({ key: "/work/secret", allowedProviders: ["local-llama"], matchedDir: "/work/secret" });
const posixMode = (path: string): number => statSync(path).mode & 0o777;

describe("temp copy markers", () => {
  it("a fusion run root's marker names the source, the session and its policy", async () => {
    const src = mkdtempSync(join(tmpdir(), "tc-src-"));
    made.push(src);
    writeFileSync(join(src, "a.txt"), "secret");
    const set = await createBranchSet(src, ["t1"], { owner: { sessionId: "s-orch", policy: secret } });
    expect(set).not.toBeNull();
    try {
      const runRoot = join(set!.baseDir, "..");
      const markerPath = join(runRoot, TEMP_COPY_MARKER);
      const marker = readTempCopyMarkerAt(markerPath, "fusion");
      expect(marker?.sessionId).toBe("s-orch");
      expect(marker?.policy?.key).toBe("/work/secret");
      expect(marker?.source).toBe(set!.realDir);
      if (process.platform !== "win32") expect(posixMode(markerPath)).toBe(0o600);
      // The workspace itself is under the recognised root.
      const inCopy = join(set!.workspaces.get("t1")!.dir, "a.txt");
      expect(isForeignTempCopy(inCopy, "s-orch")).toBe(false);
      expect(isForeignTempCopy(inCopy, "s-other")).toBe(true);
      expect(tempCopyPolicy(inCopy, { projects: {} })?.key).toBe("/work/secret");
      expect(isTempCopyMarkerPath(markerPath)).toBe(true);
    } finally {
      await set!.cleanup();
    }
  });

  it("a verify copy's marker sits beside it and goes with it", async () => {
    const work = mkdtempSync(join(tmpdir(), "tc-verify-src-"));
    const tmpRoot = mkdtempSync(join(tmpdir(), "tc-verify-tmp-"));
    made.push(work, tmpRoot);
    writeFileSync(join(work, "index.html"), "<html></html>");
    const ws = await createVerifyWorkspace(work, { tmpRoot, platform: "linux", owner: { sessionId: "s-v" } });
    expect(ws.isolated).toBe(true);
    const markerPath = `${ws.dir}${TEMP_COPY_MARKER}`;
    expect(readTempCopyMarkerAt(markerPath, "verify")).toMatchObject({ source: work, sessionId: "s-v" });
    expect(await readdir(ws.dir)).not.toContain(TEMP_COPY_MARKER);
    await ws.cleanup();
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("a spill folder's marker keeps the strictest policy the session spilled under, across restarts", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "tc-spill-"));
    made.push(baseDir);
    let policy: typeof secret | undefined;
    const result = compressToolResult(
      { tool: "os.shell.run", status: "ok", output: "x\n".repeat(5000), details: {} },
      { maxSummaryLength: 100 },
    );
    const spill = new ToolOutputSpill({ baseDir, policyFor: () => policy });
    await spill.spill("os.shell.run", "s-1", result);
    const markerPath = join(spill.dirFor("s-1"), TEMP_COPY_MARKER);
    expect(readTempCopyMarkerAt(markerPath, "spill")).toEqual({ kind: "spill", sessionId: "s-1" });
    if (process.platform !== "win32") expect(posixMode(markerPath)).toBe(0o600);
    policy = secret;
    await spill.spill("os.shell.run", "s-1", result);
    expect(readTempCopyMarkerAt(markerPath, "spill")?.policy?.key).toBe("/work/secret");
    // A new process with no policy now keeps what the folder already holds.
    policy = undefined;
    await new ToolOutputSpill({ baseDir, policyFor: () => policy }).spill("os.shell.run", "s-1", result);
    expect(readTempCopyMarkerAt(markerPath, "spill")?.policy?.key).toBe("/work/secret");
    // An unreadable marker: the folder is nobody's, so a new process
    // neither adopts nor re-stamps it, and spills nothing there.
    writeFileSync(markerPath, "garbage");
    const after = await new ToolOutputSpill({ baseDir }).spill("os.shell.run", "s-1", result);
    expect(after).toBe(result);
    expect(readFileSync(markerPath, "utf8")).toBe("garbage");
  });

  it("a marker that is a link or malformed reads as unreadable", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-marker-"));
    made.push(dir);
    const path = join(dir, TEMP_COPY_MARKER);
    writeFileSync(path, JSON.stringify({ version: 1, kind: "fusion", source: "relative/path" }));
    expect(readTempCopyMarkerAt(path, "fusion")).toBeNull();
    writeFileSync(path, JSON.stringify({ version: 1, kind: "verify", source: "/x" }));
    expect(readTempCopyMarkerAt(path, "fusion")).toBeNull();
    mkdirSync(join(dir, "sub"));
    expect(readTempCopyMarkerAt(join(dir, "sub"), "fusion")).toBeNull();
  });
});
