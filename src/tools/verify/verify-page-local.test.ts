import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalGate } from "../../approval/approval-gate.js";
import { isAutoApprovedAt } from "../../approval/approval-level.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { ToolContext } from "../tool-registry.js";
import { isLocalPageProbe } from "./verify-page-local.js";
import { parseVerifyRunArgs } from "./verify-run-args.js";
import { buildVerifyRunTool } from "./verify-run.js";

const project = resolve("/work/app");
const local = (raw: Record<string, unknown>) => isLocalPageProbe(parseVerifyRunArgs(raw), project, project);

describe("isLocalPageProbe", () => {
  it("is a page with no start command opening a project file or a loopback URL", () => {
    expect(local({ kind: "page", path: "index.html" })).toBe(true);
    expect(local({ kind: "page", path: "dist/game.html", script: [{ action: "click", selector: "#start" }] })).toBe(true);
    expect(local({ kind: "page", url: "http://127.0.0.1:5173/" })).toBe(true);
    expect(local({ kind: "page", url: "http://localhost:3000/app" })).toBe(true);
    expect(local({ kind: "page", url: "http://[::1]:8080/" })).toBe(true);
  });

  it("is not a remote URL, a file outside the project, a page with network on, or anything that starts a command", () => {
    expect(local({ kind: "page", url: "https://example.com/" })).toBe(false);
    expect(local({ kind: "page", path: "../other/index.html" })).toBe(false);
    expect(local({ kind: "page", path: "/etc/index.html" })).toBe(false);
    expect(local({ kind: "page", path: "index.html", network: true })).toBe(false);
    expect(local({ kind: "page", url: "http://127.0.0.1:3000/", start: { cmd: "npm", args: ["run", "dev"] } })).toBe(false);
    expect(local({ kind: "command", cmd: "npm", args: ["test"] })).toBe(false);
    expect(local({ kind: "service", start: { cmd: "node", args: ["server.js"] }, ready: { port: 3000 } })).toBe(false);
  });

  it("goes quiet at the auto level (2), like workspace writes, and asks below it", () => {
    expect(isAutoApprovedAt(2, "verify_page_local")).toBe(true);
    expect(isAutoApprovedAt(1, "verify_page_local")).toBe(false);
  });
});

const CONFIG = { browser: { enabled: true, channel: "chrome", headless: true, cdpUrl: null, connect: "agent", userChromeDataDir: null, executablePath: null, noSandbox: false, launchTimeoutMs: 1_000, blockedDomains: [], allowedDomains: [] } } as unknown as Pick<AtomicAgentConfig, "browser">;

describe("verify.run local page probe request", () => {
  let work: string;
  beforeEach(async () => { work = await mkdtemp(join(tmpdir(), "atag-verify-page-")); });
  afterEach(async () => { await rm(work, { recursive: true, force: true }); });

  function gate(scoped = false) {
    const request = vi.fn(async (_req: Record<string, unknown>) => ({ approved: false, reason: "test" }));
    return { request, gate: { request, fanoutScopes: { allows: () => scoped } } as unknown as ApprovalGate };
  }
  const ctx = (): ToolContext => ({ workingDir: work, sessionId: "s1", stepIndex: 0, signal: new AbortController().signal });

  it("asks as verify_page_local, not shell", async () => {
    const { gate: g, request } = gate();
    await buildVerifyRunTool({ approvals: g, approvalRequired: true, config: CONFIG }).run({ kind: "page", path: "index.html" }, ctx()).catch(() => {});
    expect(request.mock.calls[0]?.[0]).toMatchObject({ tool: "verify.run", category: "verify_page_local" });
  });

  it("a remote page still asks as shell", async () => {
    const { gate: g, request } = gate();
    await buildVerifyRunTool({ approvals: g, approvalRequired: true, config: CONFIG }).run({ kind: "page", url: "https://example.com/" }, ctx()).catch(() => {});
    expect(request.mock.calls[0]?.[0]).toMatchObject({ category: "shell" });
  });

  it("a worker's fan-out scope still covers a local page probe", async () => {
    const { gate: g, request } = gate(true);
    await buildVerifyRunTool({ approvals: g, approvalRequired: true, config: CONFIG }).run({ kind: "page", path: "index.html" }, ctx()).catch(() => {});
    expect(request).not.toHaveBeenCalled();
  });
});

describe("a shell session grant", () => {
  it("covers a local page probe, which is narrower than a shell command", async () => {
    const { ApprovalGate } = await import("../../approval/approval-gate.js");
    let emitted = 0;
    const gate: InstanceType<typeof ApprovalGate> = new ApprovalGate({
      emit: (req) => {
        emitted += 1;
        setImmediate(() => gate.resolve({ approvalId: req.approvalId, approved: true, grant: "category" }));
      },
    });
    await gate.request({ sessionId: "s", tool: "os.shell.run", category: "shell", reason: "npm test" });
    const probe = await gate.request({ sessionId: "s", tool: "verify.run", category: "verify_page_local", reason: "page" });
    expect(probe.approved).toBe(true);
    expect(emitted).toBe(1);
  });
});
