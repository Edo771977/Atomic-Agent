import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { buildOsSandboxEnv, buildOsSandboxPolicy, findBwrap, wrapWithOsSandbox } from "./os-sandbox.js";

const nestedMount = process.env.ATOMIC_AGENT_TEST_NESTED_MOUNT;
const bwrap = process.platform === "linux" ? findBwrap() : null;
function fixtureCommand(source: string, args: string[], network: boolean, workspaceRoots: string[] = []): Promise<{ code: number | null; output: string }> {
  const cwd = "/";
  const launch = wrapWithOsSandbox(process.execPath, ["-e", source, ...args], buildOsSandboxPolicy({
    workspaceRoots, network,
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

it.skipIf(bwrap === null || process.env.ATOMIC_AGENT_REQUIRE_BWRAP !== "1")("round 4 point 6: a service home outside the mounted trees stays private", async () => {
  const serviceRoot = (process.env.ATOMIC_AGENT_TEST_SYSTEM_ROOTS ?? "").split(":").find(path => path.startsWith("/srv/")) ?? process.cwd();
  const home = mkdtempSync(join(serviceRoot, "atomic-service-home-"));
  try {
    const marker = join(home, "ordinary-marker.txt");
    writeFileSync(marker, "synthetic home marker", { mode: 0o660 });
    const probe = await fixtureCommand(
      "try{require('node:fs').readFileSync(process.argv[1]);process.exit(2)}catch{process.exit(17)}",
      [marker], false,
    );
    expect(probe).toMatchObject({ code: 17 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});


it.skipIf(!nestedMount)("round 4 point 1: a workspace does not inherit an unlisted host submount", async () => {
  const probe = await fixtureCommand(
    "try{require('node:fs').readFileSync(process.argv[1]);process.exit(2)}catch{process.exit(17)}",
    [join(nestedMount!, "inherited", "marker")], false, [nestedMount!],
  );
  expect(probe).toMatchObject({ code: 17 });
});


it.skipIf(bwrap === null || !process.env.ATOMIC_AGENT_TEST_SYSTEM_ROOTS)("masks a system socket created after a previous launch", async () => {
  const root = process.env.ATOMIC_AGENT_TEST_SYSTEM_ROOTS!.split(":").find(dir => dir.startsWith("/usr/lib/"))!;
  const path = join(root, `late-${process.pid}.sock`);
  // The previous launch sees a traversable directory with no socket to mask.
  chmodSync(root, 0o755);
  try {
    expect(await fixtureCommand("", [], true)).toMatchObject({ code: 0 });
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
  } finally {
    chmodSync(root, 0o770);
  }
});

it.skipIf(bwrap === null || process.env.ATOMIC_AGENT_REQUIRE_BWRAP !== "1")("round 5 point 1: effective private proc mounts keep kernel controls read-only", async () => {
  const probe = await fixtureCommand(`
    const fs = require("node:fs");
    const mounts = fs.readFileSync("/proc/self/mountinfo", "utf8").trim().split("\\n").map(line => line.split(" "));
    const paths = ["/proc", "/proc/sys", "/proc/sys/kernel/core_pattern", "/proc/sysrq-trigger", "/proc/irq", "/proc/bus"];
    for (const path of paths.filter(p => fs.existsSync(p))) {
      const covering = mounts.filter(row => path === row[4] || path.startsWith(row[4] + "/"))
        .sort((a, b) => a[4].length - b[4].length).at(-1);
      if (!covering || !covering[5].split(",").includes("ro")) process.exit(4);
    }
  `, [], false);
  expect(probe).toMatchObject({ code: 0 });
});

it.skipIf(bwrap === null || process.env.ATOMIC_AGENT_REQUIRE_BWRAP !== "1")("round 5 point 2: pins protected ancestors without freezing ordinary writes", async () => {
  const root = mkdtempSync("/tmp/atomic-pinned-");
  try {
    for (const path of ["tools/bin", "nested/project/.git"]) mkdirSync(join(root, path), { recursive: true });
    vi.stubEnv("ATOMIC_AGENT_SANDBOX_TOOLCHAINS", join(root, "tools/bin"));
    const probe = await fixtureCommand(`
      const fs = require("node:fs"), path = require("node:path");
      const root = process.argv[1];
      for (const name of ["tools", "nested", "nested/project"]) {
        try { fs.renameSync(path.join(root, name), path.join(root, name + "-renamed")); process.exit(7); }
        catch (error) { if (error.code !== "EBUSY") throw error; }
      }
      fs.writeFileSync(path.join(root, "nested/project/ordinary"), "fixture");
    `, [root], false, [root]);
    expect(probe, probe.output).toMatchObject({ code: 0 });
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
