import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const targeted = process.argv.includes("--targeted");
const matrix = process.argv.includes("--matrix") || targeted;
const helper = realpathSync.native(resolve(process.argv[2]));
const base = realpathSync.native(mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "atomic-lpac-")));
const profile = `AtomicAgent.Workspace.${randomBytes(16).toString("hex")}`;
const root = join(base, "project");
const state = join(base, "state");
const stateFolder = join(state, "windows-sandbox");
const privateTemp = join(stateFolder, "private");
const outside = join(state, "outside");
const source = join(root, "existing.txt");
const tools = join(base, "runtime");
const gitTools = join(tools, "git");
const node = join(tools, "node.exe");
const git = join(gitTools, "git.exe");
const npmRoot = join(base, "npm");
const npm = join(npmRoot, "bin", "npm-cli.js");
const readOnlyRoots = matrix ? [helper, node, gitTools, npmRoot] : [helper, node, gitTools];
const protectedFiles = [];
const capabilityOrder = ["registryRead", "lpacCom", "lpacAppExperience", "lpacInstrumentation",
  "lpacCryptoServices", "lpacIdentityServices", "lpacPnPNotifications", "lpacServicesManagement",
  "lpacSessionManagement"];
const operator = [profile, state, root, ...readOnlyRoots];

function call(executable, args, options = {}) {
  return execFileSync(executable, args, { windowsHide: true, encoding: "utf8", timeout: 60_000, ...options });
}

function stageRequest(argv, timeoutMs = 10_000, env = {}) {
  const file = join(state, `request-${randomBytes(8).toString("hex")}.json`);
  writeFileSync(file, JSON.stringify({
    profile, cwd: root, state, privateTemp, projectFile: source, outsideCanary: outside,
    argv, writableRoots: [root], readOnlyRoots, env, timeoutMs, verbatim: 0,
  }), { flag: "wx", encoding: "utf16le" });
  return file;
}

const run = (argv, timeout) => call(helper, ["run", stageRequest(argv, timeout)]);
let server;
let granted = false;
try {
  mkdirSync(root);
  mkdirSync(state);
  call(helper, ["init-state", state, stateFolder]);
  call(helper, ["init-state", state, stateFolder]);
  mkdirSync(privateTemp);
  mkdirSync(gitTools, { recursive: true });
  writeFileSync(source, "checkout fixture\n");
  writeFileSync(join(state, "serve-api.key"), "synthetic-key\n");
  writeFileSync(outside, "synthetic-outside\n");
  call("git", ["init", "--quiet"], { cwd: root });
  call("git", ["add", "existing.txt"], { cwd: root });

  copyFileSync(process.execPath, node);
  if (matrix) {
    cpSync(join(dirname(process.execPath), "node_modules", "npm"), npmRoot, { recursive: true });
    for (const name of ["USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
      const file = join(process.env[name], `atomic-fixture-${randomBytes(8).toString("hex")}.txt`);
      writeFileSync(file, "synthetic fixture\n", { flag: "wx" });
      protectedFiles.push([name, file]);
    }
    assert.match(call(node, [npm, "--version"], { cwd: root }), /^\d+\./);
  }
  const gitSource = resolve(call("git", ["--exec-path"]).trim(), "..", "..", "bin");
  for (const name of readdirSync(gitSource).filter(name => name === "git.exe" || name.endsWith(".dll"))) {
    copyFileSync(join(gitSource, name), join(gitTools, name));
  }
  assert.match(call(git, ["status", "--short"], { cwd: root }), /existing\.txt/);
  assert.equal(call(node, ["-e", "console.log(1)"]).trim(), "1");

  process.env.ATOMIC_TEST_PARENT_SECRET = "synthetic";
  assert.equal(call(node, ["-p", "process.env.ATOMIC_TEST_PARENT_SECRET"]).trim(), "synthetic");
  granted = true;
  console.log(call(helper, ["grant", ...operator]));
  const lan = Object.values(networkInterfaces()).flat().find(item => item?.family === "IPv4" && !item.internal);
  assert.ok(lan, "the runner needs a reachable LAN address");
  server = createServer(socket => socket.destroy());
  server.listen(0, "0.0.0.0");
  await once(server, "listening");
  const port = String(server.address().port);
  const endpoints = [["127.0.0.1", port], [lan.address, port], ["1.1.1.1", "443"]];
  if (targeted) {
    const errors = [];
    const check = (label, validate) => {
      try {
        validate();
        console.log(`TARGETED ${label}: pass`);
      } catch (error) {
        errors.push(label);
        console.log(`TARGETED ${label}: fail ${[error.stderr, error.stdout].filter(Boolean).join(" | ") || error.message}`);
      }
    };
    const launch = (args, env = {}, timeout = 10_000) =>
      call(helper, ["diagnose", stageRequest(args, timeout, env), "lpac", "registryRead"]);
    const ancestorFile = join(base, "ancestor-canary");
    writeFileSync(ancestorFile, "synthetic data outside the checkout");
    const emptyConfig = join(privateTemp, "empty-git-config");
    writeFileSync(emptyConfig, "");
    const gitEnv = { ATOMIC_DIAGNOSTIC_GIT: "trace" };
    check("git-config-and-trace", () => assert.match(launch([git, "status", "--short"], gitEnv), /existing\.txt/));
    check("git-empty-config-file", () =>
      assert.match(launch([git, "status", "--short"], { ATOMIC_DIAGNOSTIC_GIT: "trace", ATOMIC_DIAGNOSTIC_EMPTY_CONFIG: "1" }), /existing\.txt/));

    const cache = join(root, ".npm-cache");
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "atomic-sandbox-fixture", version: "1.0.0", private: true,
      scripts: { test: "node -e \"console.log('sandbox npm test')\"" },
      dependencies: { "is-number": "7.0.0" },
    }));
    call(node, [npm, "install", "--cache", cache, "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root });
    rmSync(join(root, "node_modules"), { recursive: true, force: true });
    const npmArgs = [node, npm];
    try {
      check("ancestor-acl-grant", () => console.log(call(helper, ["--ancestor-acl", "grant", ...operator.slice(0, 3)])));
      check("npm-version", () => assert.match(launch([...npmArgs, "--version"]), /^\d+\./));
      check("npm-test", () => assert.match(launch([...npmArgs, "test"]), /sandbox npm test/));
      check("npm-ci-offline", () => launch([...npmArgs, "ci", "--offline", "--cache", cache, "--no-audit", "--no-fund"], {}, 30_000));
      check("directory-listing-denied", () => {
        const drive = root.slice(0, 3);
        assert.ok(readdirSync(drive).length > 0);
        assert.match(launch([node, "-e", "try { require('node:fs').readdirSync(process.argv[1]); process.exit(2) } catch(e) { if (!['EPERM','EACCES'].includes(e.code)) throw e; console.log(e.code) }", drive]), /EPERM|EACCES/);
      });
      check("ancestor-file-denied", () => {
        assert.match(call(helper, ["--file-check", "read-allow", ancestorFile]), /FILE result: 0/);
        assert.match(launch([helper, "--file-check", "read-deny", ancestorFile]), /FILE result: 5/);
      });
      for (const [name, path] of [["serve-api.key", join(state, "serve-api.key")], ...protectedFiles]) {
        check(name, () => assert.match(launch([helper, "--file-check", "read-deny", path]), /FILE result: 5/));
      }
      check("outside-write", () => assert.match(launch([helper, "--file-check", "write-deny", outside]), /FILE result: 5/));
      for (const [host, target] of endpoints) {
        check(`tcp-denied-${host}`, () => {
          assert.match(call(helper, ["--socket-allow", host, target]), /TCP result: 0/);
          assert.match(launch([helper, "--socket-deny", host, target]), /TCP result: 10013/);
        });
      }
    } finally {
      check("ancestor-acl-revoke", () => console.log(call(helper, ["--ancestor-acl", "revoke", ...operator.slice(0, 3)])));
      check("ancestor-acl-absent", () => console.log(call(helper, ["--ancestor-acl", "absent", ...operator.slice(0, 3)])));
    }
    assert.deepEqual(errors, [], "LPAC registryRead compatibility failures");
  } else if (matrix) {
    for (const [host, target] of endpoints) {
      assert.match(call(helper, ["--socket-allow", host, target]), /TCP result: 0/);
    }
    const candidates = [["lpac"], ["lpac", capabilityOrder[0]], ["lpac", capabilityOrder[1]],
      ...capabilityOrder.slice(1).map((_, i) => ["lpac", ...capabilityOrder.slice(0, i + 2)]),
      ["appcontainer"]];
    let selected;
    for (const candidate of candidates) {
      const launch = argv => call(helper, ["diagnose", stageRequest(argv), ...candidate]);
      const results = {};
      const record = (name, check) => {
        try { check(); results[name] = "pass"; }
        catch (error) {
          const diagnostic = ([error.stderr, error.stdout].filter(Boolean).join(" | ") || error.message).trim().split(/\r?\n/).slice(0, 4).join(" | ");
          results[name] = `fail: ${diagnostic}`;
        }
      };
      record("node", () => assert.equal(launch([node, "-e", "console.log(1)"]).trim(), "1"));
      record("git", () => assert.match(launch([git, "status", "--short"]), /existing\.txt/));
      record("npm", () => assert.match(launch([node, npm, "--version"]), /^\d+\./));
      for (const [name, path] of [["serve-api.key", join(state, "serve-api.key")], ...protectedFiles]) {
        assert.match(call(helper, ["--file-check", "read-allow", path]), /FILE result: 0/);
        record(name, () => assert.match(launch([helper, "--file-check", "read-deny", path]), /FILE result: 5/));
      }
      record("outside-write", () => assert.match(launch([helper, "--file-check", "write-deny", outside]), /FILE result: 5/));
      for (const [[host, target], label] of endpoints.map((endpoint, i) => [endpoint, ["loopback", "lan", "external"][i]])) {
        record(label, () => assert.match(launch([helper, "--socket-deny", host, target]), /TCP result: 10013/));
      }
      if (candidate[0] === "appcontainer") {
        for (const [name, path] of [["state-directory", state], ...["USERPROFILE", "APPDATA", "LOCALAPPDATA"].map(name => [name + "-directory", process.env[name]])]) {
          assert.match(call(helper, ["--file-check", "read-allow", path]), /FILE result: 0/);
          record(name, () => assert.match(launch([helper, "--file-check", "read-deny", path]), /FILE result: 5/));
        }
        record("package-acl-audit", () => {
          const audit = call("pwsh.exe", ["-NoProfile", "-File",
            fileURLToPath(new URL("./audit-app-packages.ps1", import.meta.url)), state], { timeout: 240_000 });
          for (const line of audit.trim().split(/\r?\n/)) {
            console.log("APP_PACKAGES_AUDIT " + line);
          }
          const entries = audit.trim().split(/\r?\n/).map(line => JSON.parse(line));
          assert.equal(entries.length, 2);
          assert.ok(entries.every(item => item.readable === 0 && item.inaccessibleToAudit === 0),
            "the profile or state has packaged-app grants or could not be fully audited");
        });
      }
      const passed = Object.values(results).every(value => value === "pass");
      const verdict = { candidate, passed, results };
      console.log("LPAC_MATRIX " + JSON.stringify(verdict));
      if (passed) { selected = candidate; break; }
    }
    console.log("LPAC_SELECTED " + JSON.stringify(selected ?? null));
    assert.ok(selected, "no candidate passed all compatibility and containment checks");
  } else {
    assert.match(run([git, "status", "--short"]), /existing\.txt/);
    assert.equal(run([node, "-e", "console.log(1)"]).trim(), "1");
    assert.equal(run([node, "-p", "process.env.ATOMIC_TEST_PARENT_SECRET"]).trim(), "undefined");

    for (const [host, target] of endpoints) {
      assert.match(call(helper, ["--socket-allow", host, target]), /TCP result: 0/);
      call(helper, ["--socket-winrt-allow", host, target]);
      assert.match(run([helper, "--socket-deny", host, target]), /TCP result: 10013/);
    }

  }

  if (!matrix) {
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
  }
} finally {
  server?.close();
  if (granted) console.log(call(helper, ["revoke", ...operator]));
  for (const [, path] of protectedFiles) rmSync(path, { force: true });
  rmSync(base, { recursive: true, force: true });
}
