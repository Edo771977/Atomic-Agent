import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installPolicy } from "../../../policy/policy-active.js";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { buildOsFsArchiveExtractTool } from "./extract-tool.js";
afterEach(() => installPolicy(null));
describe("policy uses archive entries rather than just destination scope", () => {
  it.each(["ordinary.txt", "blocked.txt"])("checks the full fake entry list: %s", async file => {
    const root = mkdtempSync(join(tmpdir(), "policy-archive-"));
    try {
      const archive = join(root, "fixture.zip"); writeFileSync(archive, "synthetic adapter input");
      installPolicy({ sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "edit", resource: join(root, "blocked.txt").replace(/\\/g, "/"), effect: "deny" }] });
      let extracted = false;
      const tool = buildOsFsArchiveExtractTool({ approvals: new ApprovalGate({ level: 5, emit: () => undefined }), approvalRequired: false,
        backends: { zip: () => ({ format: "zip", list: async () => [{ path: file, kind: "file" }], readEntry: async () => Buffer.alloc(0),
          extract: async () => { extracted = true; return { extractedEntries: 1, totalBytesWritten: 0, skippedEntries: [], warnings: [] }; } }) } });
      const run = tool.run({ path: archive, destDir: root, format: "zip" }, { workingDir: root, sessionId: "fixture", stepIndex: 0, signal: new AbortController().signal });
      if (file === "blocked.txt") { await expect(run).rejects.toThrow(/policy/); expect(extracted).toBe(false); }
      else { expect((await run).status).toBe("ok"); expect(extracted).toBe(true); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
