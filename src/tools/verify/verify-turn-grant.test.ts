import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalGate, type ApprovalRequest } from "../../approval/approval-gate.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { ProjectState } from "../../session/session-project.js";
import type { ToolContext } from "../tool-registry.js";
import { authorizeVerifyBatch } from "./verify-authorization.js";
import { buildVerifyRunTool } from "./verify-run.js";
import type { VerifyWorkspace } from "./verify-workspace-copy.js";

const CONFIG = { browser: { enabled: true, channel: "chrome", headless: true, cdpUrl: null, connect: "agent", userChromeDataDir: null, executablePath: null, noSandbox: false, launchTimeoutMs: 1_000, blockedDomains: [], allowedDomains: [] } } as unknown as Pick<AtomicAgentConfig, "browser">;
const APPROVED_PLAN = { plan: { status: "approved" } } as unknown as ProjectState;

describe("a verify_page_local yes stands for the turn in the plan's folder", () => {
  let work: string;
  let other: string;
  let asked: ApprovalRequest[];
  let gate: ApprovalGate;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "atag-verify-turn-"));
    other = join(work, "other");
    mkdirSync(other);
    writeFileSync(join(work, "index.html"), "<p>hi</p>");
    writeFileSync(join(other, "index.html"), "<p>hi</p>");
    asked = [];
    // "Allow once": approved, no session grant.
    gate = new ApprovalGate({
      emit: (req) => {
        asked.push(req);
        setImmediate(() => gate.resolve({ approvalId: req.approvalId, approved: true }));
      },
    });
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  const workspace = async (dir: string): Promise<VerifyWorkspace> =>
    ({ dir, isolated: false, method: "unavailable", error: "test seam", cleanup: async () => {} });
  const tool = () => buildVerifyRunTool({ approvals: gate, approvalRequired: true, config: CONFIG, workspace });
  const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
    ({ workingDir: work, sessionId: "director", stepIndex: 0, signal: new AbortController().signal, project: APPROVED_PLAN, ...over });
  const page = { kind: "page", path: "index.html" };

  it("asks once for two local page probes of the same folder in one turn", async () => {
    await tool().run(page, ctx());
    await tool().run(page, ctx());
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ category: "verify_page_local" });
  });

  it("covers the fan-out's contract checks for the same folder (on the director's session)", async () => {
    await tool().run(page, ctx());
    await authorizeVerifyBatch([page], { approvals: gate, approvalRequired: true }, { ...ctx(), project: undefined, ruleWorkdir: work, checkInputs: [] });
    expect(asked).toHaveLength(1);
  });

  it("a contract check's yes in the plan's folder covers the director's later probe", async () => {
    await authorizeVerifyBatch([page], { approvals: gate, approvalRequired: true, turnGrantFolder: work }, { ...ctx(), project: undefined, ruleWorkdir: work, checkInputs: [] });
    await tool().run(page, ctx());
    expect(asked).toHaveLength(1);
  });

  it("covers a worker of the same turn, through its orchestrator", async () => {
    gate.followTaint("worker-1", "director");
    await tool().run(page, ctx());
    await tool().run(page, ctx({ sessionId: "worker-1", project: undefined }));
    expect(asked).toHaveLength(1);
  });

  it("asks again for a different folder, a shell command, a new turn, and without an approved plan", async () => {
    await tool().run(page, ctx());
    await tool().run(page, ctx({ workingDir: other }));
    expect(asked).toHaveLength(2);
    await tool().run({ kind: "command", cmd: "node", args: ["--version"] }, ctx());
    expect(asked).toHaveLength(3);
    gate.clearUntrustedContent("director");
    await tool().run(page, ctx());
    expect(asked).toHaveLength(4);
    const loose = (over: Partial<ToolContext> = {}) => ctx({ sessionId: "no-plan", project: undefined, ...over });
    await tool().run(page, loose());
    await tool().run(page, loose());
    expect(asked).toHaveLength(6);
  });

  it("never covers a loopback URL probe, which runs whatever that server serves", async () => {
    await tool().run(page, ctx());
    await tool().run({ kind: "page", url: "http://127.0.0.1:5173/", probes: [{ name: "x", expr: "document.title" }] }, ctx());
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatchObject({ category: "verify_page_local" });
  });

  it("asks again after outside content was read in the turn", async () => {
    gate.setTaintReview(() => true);
    await tool().run(page, ctx());
    gate.noteUntrustedContent("director", "web page");
    await tool().run(page, ctx());
    expect(asked).toHaveLength(2);
  });
});
