import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { runVerify } from "../../verify/run-verify.js";
import { buildOsShellTool } from "./shell.js";

const fixturePolicy = buildOsSandboxPolicy({ workspaceRoots: [], network: false });
const smoke = wrapWithOsSandbox(process.execPath, ["-e", ""], fixturePolicy);
const availability = smoke.ok ? spawnSync(smoke.command, smoke.args, { encoding: "utf8", timeout: 5000 }) : undefined;
const unavailable = !smoke.ok ? smoke.reason : availability?.status === 0 ? undefined
  : availability?.stderr?.trim() || availability?.error?.message || "backend probe failed";

if (unavailable !== undefined && process.env.ATOMIC_AGENT_REQUIRE_BWRAP === "1") {
  throw new Error(`Bubblewrap required for this job: ${unavailable}`);
}

if (unavailable !== undefined) console.warn(`Skipping real OS sandbox tests: ${unavailable}`);

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

    function tool(settings: OsSandboxSettings, stateDir = state, onOneShot?: () => void) {
      const gate = new ApprovalGate({
        emit: (req) => {
          if (req.oneShot) onOneShot?.();
          gate.resolve({ approvalId: req.approvalId, approved: true });
        },
      });
      return buildOsShellTool({
        approvals: gate,
        approvalRequired: true,
        stateDir,
        sandbox: () => settings,
      });
    }

    const on: OsSandboxSettings = { mode: "workspace", network: false };

    it.skipIf(process.platform !== "linux")("review 1: host temporary and runtime Unix sockets are absent", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "atomic-host-socket-"));
      const runtime = join(work, "runtime");
      await mkdir(runtime);
      const paths = [join(tmp, "fixture.sock"), join(runtime, "fixture.sock")];
      const servers = paths.map(() => createServer(socket => socket.end("fixture")));
      try {
        await Promise.all(servers.map((server, index) => new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(paths[index]!, resolve);
        })));
        vi.stubEnv("XDG_RUNTIME_DIR", runtime);
        for (const socket of paths) {
          const result = await tool(on).run({ cmd: process.execPath, args: ["-e",
            "const s=require('node:net').connect(process.argv[1]); s.on('error',()=>process.exit(17)); s.resume()", socket,
          ] }, ctx());
          expect(result.summary).toContain("exit: 17");
        }
      } finally {
        vi.unstubAllEnvs();
        await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
        await rm(tmp, { recursive: true, force: true });
      }
    });

    it.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)("review 4: a root invocation has zero effective capabilities and read-only host mounts", async () => {
      const marker = join(outside, "host-write.txt");
      const result = await tool(on).run({ cmd: process.execPath, args: ["-e", [
        "const fs=require('node:fs');",
        "console.log(fs.readFileSync('/proc/self/status','utf8').match(/^CapEff:.*$/m)[0]);",
        "try { fs.writeFileSync(process.argv[1], 'fixture'); process.exitCode=1; } catch (e) { console.log(e.code) }",
      ].join(" "), marker] }, ctx());
      expect(result.status).toBe("ok");
      expect(result.summary).toMatch(/CapEff:\s+0{16}/);
      expect(existsSync(marker)).toBe(false);
    });

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

    it("refuses a writable project containing state", async () => {
      const nestedState = join(work, "state");
      await mkdir(nestedState);
      await writeFile(join(nestedState, "serve-api.key"), "synthetic-nested-marker");
      const result = await tool(on, nestedState).run({ cmd: "cat state/serve-api.key; echo end" }, ctx());
      expect(result.status).toBe("error");
      expect(result.summary).toContain("protected agent state");
      expect(await readFile(join(nestedState, "serve-api.key"), "utf8")).toBe("synthetic-nested-marker");
    });

    it("keeps a detached shell job confined", async () => {
      const runner = tool(on);
      const job = await runner.run({
        cmd: 'echo attempt > "$ATO469_OUTSIDE/detached.txt"; echo job-alive; sleep 20',
        background: true,
      }, ctx());
      const jobId = Number(job.details?.jobId);
      expect(Number.isInteger(jobId)).toBe(true);
      try {
        expect(job.summary).toContain("job-alive");
        expect(existsSync(join(outside, "detached.txt"))).toBe(false);
      } finally {
        await runner.run({ kill: jobId }, ctx());
      }
    });

    it("wraps verify commands and protects state from the copied workspace", async () => {
      vi.stubEnv("ATOMIC_AGENT_SANDBOX", "workspace");
      vi.stubEnv("ATOMIC_AGENT_STATE_DIR", state);
      try {
        const result = await runVerify({
          kind: "command", cmd: process.execPath,
          args: ["-e", "require('node:fs').readFileSync(process.env.ATO469_STATE + '/serve-api.key')"],
        }, ctx());
        expect(result.ok).toBe(false);
        expect(result.stderrTail).toMatch(/ENOENT|EPERM|EACCES/);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it.skipIf(process.platform !== "linux")("probes a verify service within its private Linux network", async () => {
      vi.stubEnv("ATOMIC_AGENT_SANDBOX", "workspace");
      vi.stubEnv("ATOMIC_AGENT_STATE_DIR", state);
      try {
        const result = await runVerify({
          kind: "service",
          start: { cmd: process.execPath, args: ["-e",
            "require('node:http').createServer((req, res) => res.end('inside fixture')).listen(23456, '127.0.0.1')"] },
          ready: { port: 23456 },
          requests: [{ path: "/", expectBody: "inside fixture" }],
        }, ctx());
        expect(result, result.summary).toMatchObject({ ok: true, ready: true, requests: [{ ok: true }] });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it.skipIf(process.platform !== "linux")("masks a known SSH-agent socket even with networking approved", async () => {
      const path = join(work, "ssh-agent.sock");
      const server = createServer(socket => socket.end("synthetic SSH agent"));
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(path, resolve);
        });
        vi.stubEnv("SSH_AUTH_SOCK", path);
        const probe = ["-e", `require('node:net').connect(${JSON.stringify(path)}).pipe(process.stdout)`];
        const args = { cmd: process.execPath, args: probe };
        const control = await tool({ mode: "off", network: false }).run(args, ctx());
        expect(control.summary).toContain("synthetic SSH agent");
        const confined = await tool({ mode: "workspace", network: true }).run({ ...args, network: true }, ctx());
        expect(confined.status).toBe("error");
        expect(confined.summary).not.toContain("synthetic SSH agent");
      } finally {
        vi.unstubAllEnvs();
        server.close();
      }
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
        await expect(runner.run({ cmd: process.execPath, args: probe, network: true }, ctx()))
          .rejects.toThrow("networking is disabled");
        const onOneShot = vi.fn();
        const approved = await tool({ mode: "workspace", network: true }, state, onOneShot)
          .run({ cmd: process.execPath, args: probe, network: true }, ctx());
        expect(approved.summary).toContain("host network reachable");
        expect(onOneShot).toHaveBeenCalledTimes(1);
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
