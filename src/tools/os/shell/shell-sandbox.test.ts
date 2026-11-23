import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalGate } from "../../../approval/approval-gate.js";
import {
  buildOsSandboxPolicy, wrapWithOsSandbox, type OsSandboxSettings,
} from "../../../sandbox/os-sandbox.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsShellTool } from "./shell.js";

const fixturePolicy = buildOsSandboxPolicy({ workspaceRoots: [tmpdir()], network: false });
const smoke = wrapWithOsSandbox(process.execPath, ["-e", ""], fixturePolicy);
const availability = smoke.ok ? spawnSync(smoke.command, smoke.args, { encoding: "utf8", timeout: 5000 }) : undefined;
const unavailable = !smoke.ok ? smoke.reason : availability?.status === 0 ? undefined
  : availability?.stderr?.trim() || availability?.error?.message || "backend probe failed";

describe.skipIf(unavailable !== undefined)(
  unavailable === undefined ? "os.shell.run inside the Safe Mode sandbox" : `Safe Mode unavailable: ${unavailable}`,
  () => {
    let work: string;
    let outside: string;
    let state: string;

    beforeEach(async () => {
      work = await mkdtemp(join(tmpdir(), "atomic-sbx-work-"));
      // Outside every writable root: under the home folder, not temp.
      outside = await mkdtemp(join(homedir(), ".atomic-sbx-outside-"));
      state = await mkdtemp(join(homedir(), ".atomic-sbx-state-"));
      await writeFile(join(state, ".env"), "NOTE=sandbox-marker-469\n");
      await writeFile(join(state, "serve-api.key"), "synthetic-serve-marker\n");
      await writeFile(join(state, "llama-server.key"), "synthetic-llama-marker\n");
      await writeFile(join(work, "package.json"), JSON.stringify({
        scripts: { test: "node -e \"console.log('fixture-test-ok')\"" },
      }));
      // Paths reach the command through variables, so the logical guards
      // (write targets, read scope) cannot see them and only the
      // sandbox can stop the command.
      process.env.ATO469_OUTSIDE = outside;
      process.env.ATO469_STATE = state;
    });

    afterEach(async () => {
      delete process.env.ATO469_OUTSIDE;
      delete process.env.ATO469_STATE;
      for (const dir of [work, outside, state]) {
        await rm(dir, { recursive: true, force: true });
      }
    });

    function ctx(): ToolContext {
      return {
        workingDir: work,
        sessionId: "sbx",
        stepIndex: 0,
        signal: new AbortController().signal,
      };
    }

    function tool(settings: OsSandboxSettings) {
      const gate = new ApprovalGate({
        emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
      });
      return buildOsShellTool({
        approvals: gate,
        approvalRequired: true,
        stateDir: state,
        sandbox: () => settings,
      });
    }

    const on: OsSandboxSettings = { mode: "workspace", network: false };

    it("writes inside the working folder", async () => {
      await tool(on).run({ cmd: "echo inside > inside.txt" }, ctx());
      expect(await readFile(join(work, "inside.txt"), "utf8")).toBe("inside\n");
    });

    it("cannot write outside it", async () => {
      const target = join(outside, "escaped.txt");
      const result = await tool(on).run(
        { cmd: 'echo out > "$ATO469_OUTSIDE/escaped.txt"; echo end' },
        ctx(),
      );
      expect(existsSync(target)).toBe(false);
      expect(result.summary).toContain("end");
      expect(result.summary).toContain("Safe Mode sandbox");
    });

    it("cannot read the agent's .env", async () => {
      const result = await tool(on).run({ cmd: 'cat "$ATO469_STATE/.env"; echo end' }, ctx());
      expect(result.summary).not.toContain("sandbox-marker-469");
      expect(result.summary).toContain("end");
    });

    it("protects both state keys and keeps npm test and git status usable", async () => {
      const runner = tool(on);
      const keys = await runner.run({ cmd: 'cat "$ATO469_STATE/serve-api.key" "$ATO469_STATE/llama-server.key"; echo end' }, ctx());
      expect(keys.summary).toContain("end");
      expect(keys.summary).not.toMatch(/synthetic-(serve|llama)-marker/);
      const npm = await runner.run({ cmd: "npm", args: ["test"] }, ctx());
      expect(npm.summary).toContain("fixture-test-ok");
      const git = await runner.run({ cmd: "git init -q && git status --short" }, ctx());
      expect(git.summary).toContain("?? package.json");
    });

    it.skipIf(process.platform !== "linux")("hides another process and blocks access to a host listener", async () => {
      const serve = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "synthetic-serve-argv"], {
        env: { ...process.env, ATOMIC_AGENT_API_KEY: "synthetic-serve-environment" },
      });
      const server = createServer(socket => socket.end("host network reachable"));
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string" || serve.pid === undefined) throw new Error("fixture unavailable");
        expect(await readFile(`/proc/${serve.pid}/environ`, "utf8")).toContain("synthetic-serve-environment");
        const runner = tool(on);
        const proc = await runner.run({ cmd: "cat", args: [`/proc/${serve.pid}/environ`, `/proc/${serve.pid}/cmdline`] }, ctx());
        expect(proc.status).toBe("error");
        expect(proc.summary).not.toMatch(/synthetic-serve-(environment|argv)/);
        const probe = ["-e", `require('node:net').connect(${address.port}, '127.0.0.1').pipe(process.stdout)`];
        const denied = await runner.run({ cmd: process.execPath, args: probe }, ctx());
        expect(denied.status).toBe("error");
        const allowed = await tool({ mode: "off", network: false }).run({ cmd: process.execPath, args: probe }, ctx());
        expect(allowed.summary).toContain("host network reachable");
      } finally {
        serve.kill();
        server.close();
      }
    });

    // Review fix: `cwd` is the model's argument; starting the command in
    // a denied or outside folder must not widen the sandbox to it.
    it("a cwd in the state dir does not reopen it", async () => {
      const result = await tool(on).run(
        { cmd: "cat .env; echo end", cwd: state },
        ctx(),
      );
      expect(result.summary).not.toContain("sandbox-marker-469");
    });

    it("a cwd outside the working folder does not make it writable", async () => {
      await tool(on).run({ cmd: "echo x > escaped.txt", cwd: outside }, ctx());
      expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
    });

    it("runs as before when Safe Mode is off", async () => {
      await mkdir(join(outside, "d"), { recursive: true });
      const target = join(outside, "d", "free.txt");
      await tool({ mode: "off", network: false }).run({ cmd: 'echo free > "$ATO469_OUTSIDE/d/free.txt"' }, ctx());
      expect(existsSync(target)).toBe(true);
    });
  },
);
