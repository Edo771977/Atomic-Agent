import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { makeProviderPolicy } from "../../config/project-constraint-match.js";
import { createBranchSet } from "../fusion/branch-workspace.js";
import { createVerifyWorkspace } from "../verify/verify-workspace-copy.js";
import { isForeignTempCopy, TEMP_COPY_MARKER, tempCopyPolicy } from "./index.js";

/**
 * Review of issue #74: a fusion or verify marker must name its source,
 * and a marker rewritten for a root this process made is caught.
 */
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const none = { projects: {} };
const secret = makeProviderPolicy({ key: "/work/secret", allowedProviders: ["local-llama"], matchedDir: "/work/secret" });

describe("temp copy marker integrity", () => {
  it("a fusion or verify marker without a source fails closed", () => {
    const fusion = mkdtempSync(join(tmpdir(), "atag-fusion-feed00-"));
    made.push(fusion);
    mkdirSync(join(fusion, "base"));
    writeFileSync(join(fusion, TEMP_COPY_MARKER), JSON.stringify({ version: 1, kind: "fusion", sessionId: "s" }), { mode: 0o600 });
    expect(tempCopyPolicy(join(fusion, "base", "a"), none)?.allowedProviders).toEqual([]);
    expect(isForeignTempCopy(join(fusion, "base", "a"), "s")).toBe(true);
    const verify = join(tmpdir(), `atag-verify-${(process.pid % 0xffff).toString(16).padStart(4, "0")}beef`);
    mkdirSync(verify, { recursive: true });
    made.push(verify, `${verify}${TEMP_COPY_MARKER}`);
    writeFileSync(`${verify}${TEMP_COPY_MARKER}`, JSON.stringify({ version: 1, kind: "verify" }), { mode: 0o600 });
    expect(tempCopyPolicy(join(verify, "a"), none)?.allowedProviders).toEqual([]);
  });

  it("a rewritten marker of a fusion root this process made is detected", async () => {
    const src = mkdtempSync(join(tmpdir(), "tc-integrity-src-"));
    made.push(src);
    writeFileSync(join(src, "a.txt"), "secret");
    const set = await createBranchSet(src, ["t1"], { owner: { sessionId: "s-orch", policy: secret } });
    try {
      const runRoot = join(set!.baseDir, "..");
      const inCopy = join(set!.workspaces.get("t1")!.dir, "a.txt");
      expect(tempCopyPolicy(inCopy, none)?.key).toBe("/work/secret");
      // Same shape, policy dropped and owner changed: a spoof.
      writeFileSync(join(runRoot, TEMP_COPY_MARKER), JSON.stringify({ version: 1, kind: "fusion", source: src, sessionId: "s-thief" }));
      expect(tempCopyPolicy(inCopy, none)?.allowedProviders).toEqual([]);
      expect(isForeignTempCopy(inCopy, "s-thief")).toBe(true);
    } finally {
      await set!.cleanup();
    }
  });

  it("a rewritten marker of a verify copy this process made is detected", async () => {
    const work = mkdtempSync(join(tmpdir(), "tc-integrity-verify-"));
    made.push(work);
    writeFileSync(join(work, "index.html"), "<html></html>");
    const ws = await createVerifyWorkspace(work, { platform: "linux", owner: { sessionId: "s-v", policy: secret } });
    try {
      expect(tempCopyPolicy(join(ws.dir, "index.html"), none)?.key).toBe("/work/secret");
      writeFileSync(`${ws.dir}${TEMP_COPY_MARKER}`, JSON.stringify({ version: 1, kind: "verify", source: work, sessionId: "s-v" }));
      expect(tempCopyPolicy(join(ws.dir, "index.html"), none)?.allowedProviders).toEqual([]);
    } finally {
      await ws.cleanup();
    }
  });
});
