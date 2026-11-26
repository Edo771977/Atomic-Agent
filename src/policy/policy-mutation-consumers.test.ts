import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPolicy } from "./policy-active.js";
import { requireFsApproval } from "../tools/os/fs/fs-require-approval.js";
import { ApprovalGate } from "../approval/approval-gate.js";
import { policyRuleMatch } from "./policy-enforce.js";
import { createCandidateIntegration } from "../tools/fusion/candidate-integration.js";
import type { WorkerTaskResult } from "../tools/fusion/worker-result.js";
import { commitOfficeFile } from "../tools/os/office/office-write.js";
import { buildCanvasRenderTool } from "../tools/canvas/canvas-render.js";
import { buildOsCodeRewriteTool } from "../tools/os/code/code-rewrite.js";
import * as astRunner from "../tools/os/code/ast-grep-run.js";

describe("actual mutation paths across consumers", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "policy-mutations-")); });
  afterEach(() => { installPolicy(null); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
  const deny = (resource = "*blocked.txt") => installPolicy({ sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "edit", resource, effect: "deny" }] });
  it.each(["os.fs.write", "os.fs.move", "os.fs.trash", "os.fs.archive.extract", "os.git.checkout", "os.fs.docx", "os.fs.xlsx", "os.fs.write_pptx", "os.code.rewrite", "canvas.render", "video.render_html", "video.generate"])("%s checks actual paths before an approval-disabled embedder can proceed", async tool => {
    deny(); const gate = new ApprovalGate({ level: 5, emit: () => { throw new Error("no prompt expected"); } });
    await expect(requireFsApproval({ approvals: gate, approvalRequired: false }, { kind: "write", tool, sessionId: "fixture", paths: [join(root, "blocked.txt")], workingDir: root, reason: "synthetic consumer plan" }, new AbortController().signal)).rejects.toThrow(/policy/);
  });
  it("directory operations consider denied descendants and ancestors", async () => {
    const dir = join(root, "P"); mkdirSync(dir); writeFileSync(join(dir, "blocked.txt"), "fixture"); deny(`${dir.replace(/\\/g, "/")}/*.txt`);
    const gate = new ApprovalGate({ level: 5, emit: () => undefined });
    for (const path of [dir, root]) await expect(requireFsApproval({ approvals: gate, approvalRequired: false }, { kind: "trash", tool: "os.fs.trash", sessionId: "fixture", paths: [path], workingDir: root, reason: "synthetic directory plan" }, new AbortController().signal)).rejects.toThrow(/policy/);
  });
  it("targetPaths identify edits independently of the tool name and other category", () => {
    const policy = { sources: [], mcpAllowlists: [], rules: [{ source: "system" as const, index: 0, action: "edit" as const, resource: "*blocked.txt", effect: "deny" as const }] };
    expect(policyRuleMatch(policy, { tool: "canvas.render", category: "other", targetPaths: [join(root, "blocked.txt")] })?.decision).toBe("deny");
  });
  it.each(["os.fs.docx", "os.fs.xlsx"])("the %s Office commit checks its actual filename", async tool => {
    deny(); const gate = new ApprovalGate({ level: 5, emit: () => undefined });
    const ctx = { workingDir: root, sessionId: "fixture", stepIndex: 0, signal: new AbortController().signal };
    await expect(commitOfficeFile({ approvals: gate, approvalRequired: false }, ctx, { tool, absolute: join(root, "blocked.txt"), display: "blocked.txt", data: Buffer.from("ordinary"), baseline: null, rebuild: async () => Buffer.from("ordinary"), reason: "fixture", preview: "fixture", replacesWhole: false })).rejects.toThrow(/policy/);
  });
  it("canvas checks its generated path before writing", async () => {
    deny("*.html"); const gate = new ApprovalGate({ level: 5, emit: () => undefined });
    await expect(buildCanvasRenderTool({ approvals: gate, approvalRequired: false }).run({ title: "fixture", html: "<p>ordinary fixture</p>" }, { workingDir: root, sessionId: "fixture", stepIndex: 0, signal: new AbortController().signal })).rejects.toThrow(/policy/);
  });
  it("code rewrite checks the actual files in the fake search plan", async () => {
    deny(); const path = join(root, "blocked.txt"); writeFileSync(path, "before");
    vi.spyOn(astRunner, "runAstGrep").mockResolvedValue({ kind: "ok", matches: [{ file: path, line: 1, column: 1, endLine: 1, endColumn: 7, text: "before", lines: "before", byteStart: 0, byteEnd: 6, replacement: "after", replaceStart: 0, replaceEnd: 6 }], result: { timedOut: false, truncated: false }, command: ["fake-ast"] } as never);
    const gate = new ApprovalGate({ level: 5, emit: () => undefined });
    await expect(buildOsCodeRewriteTool({ approvals: gate, approvalRequired: false }, { resolveAstGrepPath: () => "fake-ast" }).run({ pattern: "before", rewrite: "after", apply: true }, { workingDir: root, sessionId: "fixture", stepIndex: 0, signal: new AbortController().signal })).rejects.toThrow(/policy/);
  });
  it("Fusion validates the complete promotion list before copying any file", async () => {
    writeFileSync(join(root, "ordinary.txt"), "original"); writeFileSync(join(root, "blocked.txt"), "original");
    const candidate = await createCandidateIntegration(root); deny();
    try {
      writeFileSync(join(candidate.dir, "ordinary.txt"), "new ordinary"); writeFileSync(join(candidate.dir, "blocked.txt"), "new blocked");
      const rows: WorkerTaskResult[] = [{ id: "a", title: "fixture", status: "ok", reply: "done", stepCount: 1, durationMs: 1, tools: { calls: 1, errors: 0, writes: 1, byTool: {} } }];
      const report = await candidate.finish({ rows, signal: new AbortController().signal, contract: { checks: [{ kind: "command", cmd: "fixture-check" }] }, runChecks: async () => ({ ok: true, results: [{ ok: true }] }) });
      expect(report.status).toBe("rejected"); expect(report.reason).toMatch(/policy/);
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(join(root, "ordinary.txt"), "utf8")).toBe("original");
      expect(readFileSync(join(root, "blocked.txt"), "utf8")).toBe("original");
    } finally { await candidate.cleanup(); }
  });
});
