import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { expect, it } from "vitest";

import { buildOsSandboxEnv, buildOsSandboxPolicy, findBwrap, wrapWithOsSandbox } from "./os-sandbox.js";

const bwrap = process.platform === "linux" ? findBwrap() : null;
function fixtureCommand(source: string, args: string[], network: boolean): Promise<{ code: number | null; output: string }> {
  const cwd = "/";
  const launch = wrapWithOsSandbox(process.execPath, ["-e", source, ...args], buildOsSandboxPolicy({
    workspaceRoots: [], network,
  }), { bwrap });
  if (!launch.ok) throw new Error(launch.reason);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, { cwd, env: buildOsSandboxEnv(process.env), timeout: 5000 });
    let output = "";
    child.stdout.on("data", chunk => { output += String(chunk); });
    child.stderr.on("data", chunk => { output += String(chunk); });
    child.once("error", reject);
    child.once("close", code => resolve({ code, output }));
  });
}

it.skipIf(bwrap === null || process.env.ATOMIC_AGENT_REQUIRE_BWRAP !== "1")("runtime fixtures refuse sockets under var/tmp and CI runtime mounts", async () => {
  const local = mkdtempSync("/var/tmp/atomic-runtime-");
  const roots = [local, ...(process.env.ATOMIC_AGENT_TEST_RUNTIME_ROOTS ?? "").split(":").filter(Boolean)];
  try {
    for (const [index, root] of roots.entries()) {
      const path = join(root, `fixture-${process.pid}-${index}.sock`);
      const socket = createServer(client => client.end("synthetic endpoint"));
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(path, resolve);
      });
      try {
        const probe = await fixtureCommand("const s=require('node:net').connect(process.argv[1]); s.on('error',()=>process.exit(17)); s.resume()", [path], true);
        expect(probe, path).toMatchObject({ code: 17 });
      } finally {
        await new Promise<void>(resolve => socket.close(() => resolve()));
      }
    }
  } finally {
    rmSync(local, { recursive: true, force: true });
  }
});

it.skipIf(bwrap === null || process.env.ATOMIC_AGENT_REQUIRE_BWRAP !== "1")("approved networking can resolve a synthetic DNS record", async () => {
  const server = createSocket("udp4");
  server.on("message", (query, remote) => {
    let end = 12;
    while (end < query.length && query[end] !== 0) end += 1 + query[end]!;
    const question = query.subarray(12, end + 5);
    const header = Buffer.from([query[0]!, query[1]!, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
    const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, 192, 0, 2, 42]);
    server.send(Buffer.concat([header, question, answer]), remote.port, remote.address);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.bind(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    const probe = await fixtureCommand(
      "const r=new (require('node:dns').Resolver)({timeout:1000,tries:1}); r.setServers([process.argv[1]]); r.resolve4('sandbox-fixture.invalid',(err,a)=>{if(err){console.error(err.code);process.exitCode=1}else console.log(a[0])})",
      [`127.0.0.1:${port}`], true,
    );
    expect(probe).toEqual({ code: 0, output: "192.0.2.42\n" });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});


it.skipIf(bwrap === null || !process.env.ATOMIC_AGENT_TEST_SYSTEM_ROOTS)("round 4 point 1: host system socket fixtures remain unreachable with group permissions", async () => {
  const roots = process.env.ATOMIC_AGENT_TEST_SYSTEM_ROOTS!.split(":");
  for (const [index, root] of roots.entries()) {
    const path = join(root, `fixture-system-${process.pid}-${index}.sock`);
    const socket = createServer(client => client.end("synthetic endpoint"));
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(path, resolve);
    });
    try {
      chmodSync(path, 0o770);
      const probe = await fixtureCommand("const s=require('node:net').connect(process.argv[1]); s.on('error',()=>process.exit(17)); s.resume()", [path], true);
      expect(probe, path).toMatchObject({ code: 17 });
    } finally {
      await new Promise<void>(resolve => socket.close(() => resolve()));
    }
  }
}, 20_000);
