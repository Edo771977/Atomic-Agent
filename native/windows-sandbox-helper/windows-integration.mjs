import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const helper = realpathSync.native(resolve(process.argv[2]));
const base = realpathSync.native(mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "atomic-lpac-")));
const profile = `AtomicAgent.Workspace.${randomBytes(16).toString("hex")}`;
const root = join(base, "project");
const state = join(base, "state");
const privateTemp = join(state, "private");
const outside = join(state, "outside");
const source = join(root, "existing.txt");
const tools = join(base, "runtime");
const gitTools = join(tools, "git");
const node = join(tools, "node.exe");
const git = join(gitTools, "git.exe");
const readOnlyRoots = [helper, node, gitTools];
const operator = [profile, state, root, ...readOnlyRoots];

function call(executable, args, options = {}) {
  return execFileSync(executable, args, { windowsHide: true, encoding: "utf8", timeout: 60_000, ...options });
}

function stageRequest(argv, timeoutMs = 10_000) {
  const file = join(state, `request-${randomBytes(8).toString("hex")}.json`);
  writeFileSync(file, JSON.stringify({
    profile, cwd: root, state, privateTemp, projectFile: source, outsideCanary: outside,
    argv, writableRoots: [root], readOnlyRoots, env: {}, timeoutMs, verbatim: 0,
  }), { flag: "wx", encoding: "utf16le" });
  return file;
}

const run = (argv, timeout) => call(helper, ["run", stageRequest(argv, timeout)]);
let server;
let granted = false;
try {
  mkdirSync(root);
  mkdirSync(privateTemp, { recursive: true });
  mkdirSync(gitTools, { recursive: true });
  writeFileSync(source, "checkout fixture\n");
  writeFileSync(join(state, "serve-api.key"), "synthetic-key\n");
  writeFileSync(outside, "synthetic-outside\n");
  call("git", ["init", "--quiet"], { cwd: root });
  call("git", ["add", "existing.txt"], { cwd: root });

  copyFileSync(process.execPath, node);
  const gitSource = join(dirname(call("git", ["--exec-path"]).trim()), "bin");
  for (const name of readdirSync(gitSource).filter(name => name === "git.exe" || name.endsWith(".dll"))) {
    copyFileSync(join(gitSource, name), join(gitTools, name));
  }
  assert.match(call(git, ["status", "--short"], { cwd: root }), /existing\.txt/);
  assert.equal(call(node, ["-e", "console.log(1)"]).trim(), "1");

  process.env.ATOMIC_TEST_PARENT_SECRET = "synthetic";
  assert.equal(call(node, ["-p", "process.env.ATOMIC_TEST_PARENT_SECRET"]).trim(), "synthetic");
  granted = true;
  console.log(call(helper, ["grant", ...operator]));
  assert.match(run([git, "status", "--short"]), /existing\.txt/);
  assert.equal(run([node, "-e", "console.log(1)"]).trim(), "1");
  assert.equal(run([node, "-p", "process.env.ATOMIC_TEST_PARENT_SECRET"]).trim(), "undefined");

  const lan = Object.values(networkInterfaces()).flat().find(item => item?.family === "IPv4" && !item.internal);
  assert.ok(lan, "the runner needs a reachable LAN address");
  server = createServer(socket => socket.destroy());
  server.listen(0, "0.0.0.0");
  await once(server, "listening");
  const port = String(server.address().port);
  for (const [host, target] of [["127.0.0.1", port], [lan.address, port], ["1.1.1.1", "443"]]) {
    assert.match(call(helper, ["--socket-allow", host, target]), /TCP result: 0/);
    assert.match(run([helper, "--socket-deny", host, target]), /TCP result: 10013/);
  }

  const family = [
    node, "-e",
    "const cp = require('node:child_process'); const child = cp.spawn(process.execPath, " +
      "['-e', \"const cp = require('node:child_process'); const grandchild=cp.spawn(process.execPath, " +
      "['-e','setInterval(()=>{},1000)'], {stdio:'ignore'}); console.log(grandchild.pid); setInterval(()=>{},1000)\"], " +
      "{stdio:['ignore','inherit','inherit']}); console.log(child.pid); setInterval(()=>{},1000);",
  ];
  for (const cancel of [false, true]) {
    const child = spawn(helper, ["run", stageRequest(family, cancel ? 60_000 : 8000)], {
      stdio: ["ignore", "pipe", "inherit"], windowsHide: true,
    });
    const closed = once(child, "close");
    let output = "";
    let seen = false;
    child.stdout.setEncoding("utf8").on("data", chunk => {
      output += chunk;
      if (cancel && !seen && output.trim().split(/\s+/).length === 2) {
        seen = true;
        child.kill();
      }
    });
    const [status] = await closed;
    const pids = output.trim().split(/\s+/).map(Number);
    assert.equal(pids.length, 2, "both child and grandchild must start");
    if (!cancel) assert.equal(status >>> 0, 0xe0000002, "native launcher must report timeout");
    else assert.ok(seen, "cancel after the grandchild starts");
    for (const pid of pids) {
      assert.ok(Number.isInteger(pid) && pid > 0);
      for (let attempt = 0; attempt < 30; ++attempt) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") break;
          throw error;
        }
        assert.notEqual(attempt, 29, `process ${pid} survived sandbox shutdown`);
        await delay(100);
      }
    }
  }
} finally {
  server?.close();
  if (granted) console.log(call(helper, ["revoke", ...operator]));
  rmSync(base, { recursive: true, force: true });
}
