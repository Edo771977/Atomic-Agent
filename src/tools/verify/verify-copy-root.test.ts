import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalGate } from "../../approval/approval-gate.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { ToolContext } from "../tool-registry.js";
import type { VerifyWorkspace } from "./verify-workspace-copy.js";

const fake = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fake.home || actual.homedir() };
});

const { buildVerifyRunTool } = await import("./verify-run.js");

const CONFIG = { browser: { enabled: true, channel: "chrome", headless: true, cdpUrl: null, connect: "agent", userChromeDataDir: null, executablePath: null, noSandbox: false, launchTimeoutMs: 1_000, blockedDomains: [], allowedDomains: [] } } as unknown as Pick<AtomicAgentConfig, "browser">;

describe("verify.run from a session folder too broad to copy (issue #53)", () => {
  let base: string;
  let home: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "atag-verify-root-"));
    home = join(base, "home");
    mkdirSync(join(home, "proj", "site"), { recursive: true });
    writeFileSync(join(home, "proj", "site", "index.html"), "<p>hi</p>");
    fake.home = home;
  });
  afterEach(() => {
    fake.home = "";
    rmSync(base, { recursive: true, force: true });
  });

  function harness() {
    const request = vi.fn(async (_req: Record<string, unknown>) => ({ approved: true }));
    const copied: string[] = [];
    const workspace = vi.fn(async (dir: string): Promise<VerifyWorkspace> => {
      copied.push(dir);
      return { dir, isolated: false, method: "unavailable", error: "test seam", cleanup: async () => {} };
    });
    const tool = buildVerifyRunTool({
      approvals: { request, fanoutScopes: { allows: () => false } } as unknown as ApprovalGate,
      approvalRequired: true, config: CONFIG, workspace,
    });
    const ctx: ToolContext = { workingDir: home, sessionId: "s1", stepIndex: 0, signal: new AbortController().signal };
    return { request, copied, tool, ctx };
  }

  it("copies the page's folder, never the home folder, and the prompt names it", async () => {
    const { request, copied, tool, ctx } = harness();
    await tool.run({ kind: "page", path: "proj/site/index.html" }, ctx);
    expect(request).toHaveBeenCalledTimes(1);
    const prompt = request.mock.calls[0]![0] as { reason: string; affectedResources: string[] };
    expect(prompt.reason).toContain(`throwaway copy of ${join(home, "proj", "site")}`);
    expect(prompt.affectedResources).toEqual([join(home, "proj", "site")]);
    expect(copied).toEqual([join(home, "proj", "site")]);
  });

  it("says what it copied, on the prompt and in the result, so the model can widen it with cwd", async () => {
    const { request, tool, ctx } = harness();
    const result = await tool.run({ kind: "page", path: "proj/site/index.html" }, ctx);
    const note = `copied ${join(home, "proj", "site")} only; pass cwd to widen`;
    const prompt = request.mock.calls[0]![0] as { reason: string; preview: string };
    expect(prompt.reason).toContain(note);
    expect(prompt.preview).toContain(note);
    expect(result.summary).toContain(note);
  });

  it("copies the git root when the page lies inside a repository", async () => {
    mkdirSync(join(home, "proj", ".git"));
    const { request, copied, tool, ctx } = harness();
    await tool.run({ kind: "page", path: join(home, "proj", "site", "index.html") }, ctx);
    expect((request.mock.calls[0]![0] as { reason: string }).reason).toContain(`throwaway copy of ${join(home, "proj")};`);
    expect(copied).toEqual([join(home, "proj")]);
  });

  it("keeps an explicit cwd inside the copy of an opened page", async () => {
    mkdirSync(join(home, "proj", "site", "pages"));
    writeFileSync(join(home, "proj", "site", "pages", "index.html"), "<p>hi</p>");
    const { copied, tool, ctx } = harness();
    await tool.run({ kind: "page", cwd: join("proj", "site"), path: join("pages", "index.html") }, ctx);
    expect(copied).toEqual([join(home, "proj", "site")]);
  });

  it("roots a command at its cwd", async () => {
    const { request, copied, tool, ctx } = harness();
    await tool.run({ kind: "command", cmd: "node", args: ["--version"], cwd: "proj" }, ctx);
    expect((request.mock.calls[0]![0] as { affectedResources: string[] }).affectedResources).toEqual([join(home, "proj")]);
    expect(copied).toEqual([join(home, "proj")]);
  });

  it("refuses up front, without asking, when the run needs the home folder itself", async () => {
    const { request, copied, tool, ctx } = harness();
    for (const args of [{ kind: "command", cmd: "node", args: ["--version"] }, { kind: "page", path: "index.html" }]) {
      const result = await tool.run(args, ctx);
      expect(result.status).toBe("error");
      expect(result.summary).toContain("too broad");
      expect(result.summary).toContain("workspace chip");
    }
    expect(request).not.toHaveBeenCalled();
    expect(copied).toEqual([]);
  });

  it("leaves an ordinary project folder's copy as it was", async () => {
    const { request, copied, tool } = harness();
    const proj = join(home, "proj");
    await tool.run({ kind: "page", path: "site/index.html" }, { workingDir: proj, sessionId: "s1", stepIndex: 0, signal: new AbortController().signal });
    expect((request.mock.calls[0]![0] as { affectedResources: string[] }).affectedResources).toEqual([proj]);
    expect(copied).toEqual([proj]);
  });
});
