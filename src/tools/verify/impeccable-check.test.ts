import { realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runVerify as executeVerify } from "./run-verify.js";
import { authorizeVerifyBatch } from "./verify-authorization.js";

let root: string;
let bin: string;
const windows = process.platform === "win32";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "verify impeccable "));
  bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(root, "style.css"), "p { color: #aaa; }");
  vi.stubEnv("PATH", bin);
  await writeFile(join(root, "index.html"), "<!-- impeccable-disable-next-line low-contrast -->\n<link rel=\"stylesheet\" href=\"style.css\"><p>Hello</p>");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function finding(antipattern: string, extra = {}) {
  return { antipattern, name: antipattern, description: "Fixture", category: "quality",
    severity: "warning", file: "./index.html", line: 2, snippet: "Fixture", ...extra };
}

async function fake(exit: number, payload: unknown, name = "impeccable", url?: string, diagnostic?: string) {
  const script = join(bin, `${name}.cjs`);
  await writeFile(script, `
    const args = process.argv.slice(2);
    if (args[0] === "--version") console.log("impeccable 1.2.3");
    else if (args.slice(0, 3).join(" ") === "detect --json --no-config" && args.length === 4) {
      const fs = require("node:fs");
      const path = require("node:path");
      if (${url !== undefined} ? args[3] !== ${JSON.stringify(url ?? "")} : !fs.readFileSync(path.join(path.dirname(args[3]), "style.css"), "utf8").includes("#aaa")) process.exit(97);
      if (process.env.DO_NOT_TRACK !== "1") process.exit(98);
      if (${payload !== undefined}) console.log(${JSON.stringify(JSON.stringify(payload))});
      if (${diagnostic !== undefined}) console.error(${JSON.stringify(diagnostic ?? "")});
      process.exitCode = ${exit};
    } else process.exitCode = 99;
  `);
  const launcher = windows ? `@"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`;
  await writeFile(join(bin, windows ? `${name}.cmd` : name), launcher, { mode: 0o700 });
}

async function approve(spec: Record<string, unknown>, workingDir: string, signal = new AbortController().signal) {
  return (await authorizeVerifyBatch([spec], { approvals: {} as never, approvalRequired: false },
    { workingDir, signal, sessionId: "test", stepIndex: 0 }))[0]!;
}

async function runVerify(spec: Record<string, unknown>, ctx: Parameters<typeof executeVerify>[1]) {
  return executeVerify(await approve(spec, ctx.workingDir, ctx.signal), ctx);
}

const check = () => runVerify({ kind: "ui", path: "index.html" }, { workingDir: root });

it("fails on a severe rule and records its source file, CLI version and suppression", async () => {
  await fake(2, [finding("low-contrast")]);
  const result = await check();
  expect(result).toMatchObject({ ok: false, artifactStatus: "fail", impeccableVersion: "impeccable 1.2.3" });
  expect(result.stdoutTail).toContain("low-contrast — index.html");
  expect(result.stdoutTail).toContain("index.html:1: impeccable-disable-next-line");
});

it("retains warning-only findings on a pass", async () => {
  await fake(2, [finding("bounce-easing")]);
  expect(await check()).toMatchObject({ ok: true, artifactStatus: "pass", stdoutTail: expect.stringContaining("bounce-easing — index.html") });
});

it.each([[1, undefined, "exit 1"], [0, { filesScanned: 1, findings: [] }, "invalid findings"],
  [2, [finding("bounce-easing", { advisory: true })], "no primary findings"]])(
  "returns uncheckable for invalid scan output at exit %i", async (exit, payload, message) => {
    await fake(exit, payload);
    expect(await check()).toMatchObject({ ok: false, artifactStatus: "uncheckable", error: expect.stringContaining(message) });
  },
);

it("passes a clean JSON array on a markup file with linked CSS in the private copy", async () => {
  await fake(0, []);
  expect(await check()).toMatchObject({ ok: true, artifactStatus: "pass" });
});

it("refuses to treat a CSS-only scan as markup coverage", async () => {
  await fake(0, []);
  const result = await runVerify({ kind: "ui", path: "style.css" }, { workingDir: root });
  expect(result.error).toContain("impeccable scans markup");
});

it.each([["broken-image", {}], ["script-error", { severity: "error" }]])("fails on %s", async (id, extra) => {
  await fake(2, [finding(id, extra)]);
  expect(await check()).toMatchObject({ artifactStatus: "fail" });
});

it("treats an explicit advisory as a warning even when its rule is severe", async () => {
  await fake(2, [finding("broken-image", { severity: "error", advisory: true }), finding("bounce-easing")]);
  expect(await check()).toMatchObject({ artifactStatus: "pass", impeccableFindings: expect.arrayContaining(["warning: broken-image — index.html"]) });
});

it("uses severe IDs from the pinned upstream catalog", async () => {
  const { readFile } = await import("node:fs/promises");
  const catalog = JSON.parse(await readFile(new URL("./fixtures/impeccable-antipatterns-b49177d.json", import.meta.url), "utf8")) as { id: string }[];
  const checkModule = await import("./impeccable-check.js");
  const rules = checkModule.SEVERE_RULES;
  expect(rules).toContain("broken-image");
  for (const id of rules) expect(catalog.map(rule => rule.id)).toContain(id);
});

it("returns uncheckable without executing a package runner when impeccable is absent", async () => {
  const marker = join(root, "runner-used");
  await writeFile(join(bin, windows ? "npx.cmd" : "npx"), windows
    ? `@echo used>"${marker}"\r\n` : `#!/bin/sh\nprintf used > '${marker}'\n`, { mode: 0o700 });
  expect(await check()).toMatchObject({ ok: false, artifactStatus: "uncheckable", error: expect.stringContaining("impeccable is not installed") });
  await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it("runs through Fusion, preserving the evidence and failing the linked criterion", async () => {
  const { runContractChecks } = await import("../fusion/contract-checks.js");
  const { criteriaFactsFor, taskCriteria } = await import("../fusion/criteria-facts.js");
  const { runChecks } = await import("./run-verify.js");
  await fake(2, [finding("low-contrast")]);
  const contract = { checks: [{ task: "design", kind: "ui", path: "index.html", criteria: ["contrast"] }] };
  const brief = new Map([["contrast", { id: "contrast", text: "Readable text contrast" }]]);
  const { outcomes } = await runContractChecks(contract.checks, async (specs, ctx) =>
    runChecks(await Promise.all(specs.map(spec => approve(spec, ctx.workingDir, ctx.signal))), ctx), { workingDir: root, signal: new AbortController().signal });
  expect(outcomes).toEqual([expect.objectContaining({
    task: "design",
    ok: false,
    criteria: ["contrast"],
    impeccableFindings: ["severe: low-contrast — index.html"],
    impeccableSuppressions: ["index.html:1: impeccable-disable-next-line"],
  })]);
  expect(criteriaFactsFor(taskCriteria("design", contract, brief), contract, outcomes, undefined))
    .toMatchObject([{ id: "contrast", state: "failed" }]);
});

it("refuses network and checks read scope before asking for approval", async () => {
  await fake(0, []);
  const { authorizeVerifyBatch } = await import("./verify-authorization.js");
  const ctx = { workingDir: root, sessionId: "test", stepIndex: 0, signal: new AbortController().signal };
  const checkReadTargets = vi.fn(async () => ({ tool: "verify.run", status: "error" as const, summary: "read denied", details: {}, truncated: false }));
  const options = { approvals: {} as never, approvalRequired: false, checkReadTargets };
  await expect(authorizeVerifyBatch([{ kind: "ui", path: "index.html", network: true }], options, ctx)).rejects.toThrow("do not accept network");
  expect(checkReadTargets).not.toHaveBeenCalled();
  await expect(authorizeVerifyBatch([{ kind: "ui", path: "index.html" }], options, ctx)).rejects.toThrow("read denied");
  expect(checkReadTargets).toHaveBeenCalledWith("verify.run", { path: join(root, "index.html") }, expect.anything(), "os.fs.read");
});

it("honors the deadline for a stalled detector", async () => {
  await fake(2, []);
  const script = join(bin, "impeccable.cjs");
  await writeFile(script, 'if (process.argv[2] === "--version") console.log("1.2.3"); else setInterval(() => {}, 100);');
  const result = await runVerify({ kind: "ui", path: "index.html", timeoutMs: 500 }, { workingDir: root });
  expect(result).toMatchObject({ ok: false, artifactStatus: "uncheckable", timedOut: true });
});

it("cancels a blocked detector process", async () => {
  await fake(2, []);
  const script = join(bin, "impeccable.cjs");
  const marker = join(root, "detector-started");
  await writeFile(script, `
    if (process.argv[2] === "--version") console.log("1.2.3");
    else {
      require("node:fs").writeFileSync(${JSON.stringify(marker)}, "");
      setInterval(() => {}, 100);
    }
  `);
  const controller = new AbortController();
  const result = runVerify({ kind: "ui", path: "index.html" }, { workingDir: root, signal: controller.signal });
  try {
    await vi.waitFor(() => access(marker), { timeout: 3_000 });
  } finally {
    controller.abort();
  }
  expect(await result).toMatchObject({ ok: false, artifactStatus: "uncheckable", errorCode: "cancelled" });
});

it("pins the authorized executable and refuses a higher-priority launcher planted during approval", async () => {
  const { buildVerifyRunTool } = await import("./verify-run.js");
  const spawn = await import("./spawn-verify-process.js");
  const spawnSpy = vi.spyOn(spawn, "spawnVerifyProcess");
  const spec = { kind: "ui", path: "index.html" };
  const executable = join(bin, windows ? "impeccable.cmd" : "impeccable");
  await fake(0, []);
  const resolvedExecutable = realpathSync.native(executable);
  const request = vi.fn(async () => {
    const local = join(root, "node_modules", ".bin");
    await mkdir(local, { recursive: true });
    await writeFile(join(local, windows ? "impeccable.cmd" : "impeccable"), "inert fixture", { mode: 0o700 });
    return { approved: true, reason: "test" };
  });
  const checkCommandReads = vi.fn(async () => null);
  try {
    const tool = buildVerifyRunTool({ approvals: { request } as never, approvalRequired: true, config: {} as never, checkCommandReads });
    const result = await tool.run(spec, { workingDir: root, signal: new AbortController().signal, sessionId: "test", stepIndex: 0 });
    expect(result.status).toBe("ok");
    expect(spawnSpy.mock.calls.map(call => call[0])).toEqual([resolvedExecutable, resolvedExecutable]);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      category: "verify_ui_detector", preview: expect.stringContaining("impeccable"), reason: expect.stringContaining("impeccable"),
      commandArgv: [resolvedExecutable, "detect", "--json", "--no-config", join(root, "index.html")],
      commandSegments: expect.arrayContaining([[resolvedExecutable, "detect", "--json", "--no-config", join(root, "index.html")]]),
    }), expect.anything());
    expect(checkCommandReads).toHaveBeenCalled();
  } finally {
    spawnSpy.mockRestore();
  }
});

it("blocks a saved shell deny and does not reuse a document allow", async () => {
  const { authorizeVerifyBatch } = await import("./verify-authorization.js");
  const { matchRules } = await import("../../approval/approval-rules.js");
  const spec = { kind: "ui", path: "index.html" };
  const ctx = { workingDir: root, signal: new AbortController().signal, sessionId: "test", stepIndex: 0 };
  await fake(0, []);
  const executable = join(bin, windows ? "impeccable.cmd" : "impeccable");
  const allow = { id: "doc", decision: "allow", tool: "verify.run", category: "shell" } as const;
  const deny = { id: "deny", decision: "deny", tool: "os.shell.run", category: "shell", commandPrefix: [executable] } as const;
  const ruleDecisionFor = vi.fn((req: Parameters<typeof matchRules>[1]) => matchRules([allow, deny] as never, req)?.decision ?? null);
  const request = vi.fn(async () => ({ approved: false, reason: "blocked by a saved command rule", automatic: true }));
  await expect(authorizeVerifyBatch([spec], { approvals: { request, ruleDecisionFor } as never, approvalRequired: true }, ctx))
    .rejects.toThrow("blocked by a saved command rule");
  const prompt = ruleDecisionFor.mock.calls[0]![0];
  expect(matchRules([allow] as never, prompt)).toBeNull();
  expect(matchRules([deny] as never, prompt)?.decision).toBe("deny");
});

it("never spawns a replaced approved launcher, including under a nested cwd", async () => {
  const { buildVerifyRunTool } = await import("./verify-run.js");
  const spawn = await import("./spawn-verify-process.js");
  const spy = vi.spyOn(spawn, "spawnVerifyProcess");
  const local = join(root, "app", "node_modules", ".bin");
  await mkdir(local, { recursive: true });
  const executable = join(local, windows ? "impeccable.cmd" : "impeccable");
  await writeFile(executable, "inert original", { mode: 0o700 });
  await writeFile(join(root, "app", "index.html"), "<p>Hello</p>");
  const request = vi.fn(async () => {
    await writeFile(executable, "inert replacement contents", { mode: 0o700 });
    return { approved: true, reason: "test" };
  });
  try {
    const tool = buildVerifyRunTool({ approvals: { request } as never, approvalRequired: true, config: {} as never });
    const result = await tool.run({ kind: "ui", cwd: "app", path: "index.html" }, {
      workingDir: root, signal: new AbortController().signal, sessionId: "test", stepIndex: 0,
    });
    expect(result.details).toMatchObject({ artifactStatus: "uncheckable", error: expect.stringContaining("changed after approval") });
    expect(spy).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ preview: expect.stringContaining("project executable:") }), expect.anything());
  } finally {
    spy.mockRestore();
  }
});

it("reports suppression attributes and block markers and withholds a pass when they could hide findings", async () => {
  await fake(0, []);
  await writeFile(join(root, "index.html"), [
    '<!-- impeccable-ignore-start broken-image -->',
    '<link rel="stylesheet" href="style.css">',
    '<img data-impeccable-ignore="broken-image" src="">',
    '<!-- impeccable-ignore-end -->',
  ].join("\n"));
  expect(await check()).toMatchObject({
    artifactStatus: "uncheckable",
    impeccableSuppressions: [
      "index.html:1: impeccable-ignore-start",
      'index.html:3: data-impeccable-ignore="broken-image"',
      "index.html:4: impeccable-ignore-end",
    ],
  });
});

it("bounds both kinds of Fusion evidence and reports omitted entries", async () => {
  const { CHECK_OUTPUT_CHARS, runContractChecks } = await import("../fusion/contract-checks.js");
  const entries = Array.from({ length: 800 }, (_, index) => `finding ${index}`);
  const { outcomes: [outcome] } = await runContractChecks([{ kind: "ui", path: "index.html" }], async () => ({
    ok: true, results: [{ ok: true, impeccableFindings: entries, impeccableSuppressions: entries }],
  }), { workingDir: root, signal: new AbortController().signal });
  const findings = outcome?.impeccableFindings?.join("\n") ?? "";
  const suppressions = outcome?.impeccableSuppressions?.join("\n") ?? "";
  expect(findings.length + suppressions.length).toBeLessThanOrEqual(CHECK_OUTPUT_CHARS);
  expect(findings).toMatch(/\+\d+ more$/);
  expect(suppressions).toMatch(/\+\d+ more$/);
});

it.skipIf(windows)("honors a saved deny on the npm launcher name when its real file is cli.js", async () => {
  const { buildVerifyRunTool } = await import("./verify-run.js");
  const { matchRules } = await import("../../approval/approval-rules.js");
  const spawn = await import("./spawn-verify-process.js");
  const spy = vi.spyOn(spawn, "spawnVerifyProcess");
  try {
    await fake(0, []);
    await rename(join(bin, "impeccable"), join(bin, "cli.js"));
    await symlink("cli.js", join(bin, "impeccable"));
    const ruleDecisionFor = (req: Parameters<typeof matchRules>[1]) => matchRules([{
      decision: "deny", tool: "os.shell.run", category: "shell", commandPrefix: ["impeccable", "detect"],
    }] as never, req)?.decision ?? null;
    const request = vi.fn(async (req: Parameters<typeof matchRules>[1]) => ({
      approved: ruleDecisionFor(req) !== "deny", reason: "blocked by saved impeccable rule", automatic: true,
    }));
    const tool = buildVerifyRunTool({ approvals: { request, ruleDecisionFor } as never, approvalRequired: true, config: {} as never });
    const result = await tool.run({ kind: "ui", path: "index.html" }, {
      workingDir: root, signal: new AbortController().signal, sessionId: "test", stepIndex: 0,
    });
    expect(result.details).toMatchObject({ artifactStatus: "uncheckable", error: expect.stringContaining("saved approval rule") });
    expect(request).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

it.each([["style.css", "scans markup"], ["index.html", "is not installed"]])(
  "returns uncheckable without approval or a copy for %s",
  async (path, reason) => {
    const { buildVerifyRunTool } = await import("./verify-run.js");
    if (path.endsWith(".css")) await fake(0, []);
    const request = vi.fn(async () => ({ approved: true, reason: "test" }));
    const workspace = vi.fn(async () => { throw new Error("the project must not be copied"); });
    const tool = buildVerifyRunTool({ approvals: { request } as never, approvalRequired: true, config: {} as never, workspace });
    const result = await tool.run({ kind: "ui", path }, { workingDir: root, sessionId: "test", stepIndex: 0, signal: new AbortController().signal });
    expect(result.details).toMatchObject({ artifactStatus: "uncheckable", error: expect.stringContaining(reason) });
    expect(request).not.toHaveBeenCalled();
    expect(workspace).not.toHaveBeenCalled();
  },
);

it("treats severity advisory as advisory without a flag", async () => {
  await fake(0, [finding("low-contrast", { severity: "advisory" })]);
  expect(await check()).toMatchObject({ artifactStatus: "pass", impeccableFindings: ["warning: low-contrast — index.html"] });
});

it("bounds verify.run Impeccable details and counts omitted entries", async () => {
  await fake(2, Array.from({ length: 350 }, () => finding("broken-image")));
  await writeFile(join(root, "index.html"), '<link rel="stylesheet" href="style.css">\n' + '<!-- impeccable-disable broken-image -->\n'.repeat(350));
  const result = await check();
  const findings = result.impeccableFindings?.join("\n") ?? "";
  const suppressions = result.impeccableSuppressions?.join("\n") ?? "";
  expect(result.artifactStatus).toBe("fail");
  expect(Buffer.byteLength(JSON.stringify([result.impeccableFindings, result.impeccableSuppressions]))).toBeLessThanOrEqual(8192);
  expect(findings).toMatch(/\+\d+ more$/);
  expect(suppressions).toMatch(/\+\d+ more$/);
});

it.each(["denied", "unavailable", "saved deny"] as const)("continues the Fusion batch when UI approval is %s", async mode => {
  const { createContractCheckHold } = await import("../fusion/contract-check-hold.js");
  const { runContractChecks } = await import("../fusion/contract-checks.js");
  const ui = { kind: "ui", path: "index.html" };
  const command = { kind: "command", cmd: "node", args: ["check.js"] };
  const checks = [command, ui, command];
  const signal = new AbortController().signal;
  await fake(0, []);
  const approvals = {
    ruleDecisionFor: vi.fn((prompt: { category: string }) => mode === "saved deny" && prompt.category === "verify_ui_detector" ? "deny" as const : null),
    request: vi.fn(async (prompt: { category: string }) => prompt.category === "verify_ui_detector"
      ? { approved: false, reason: mode, automatic: mode !== "denied", approvalId: "denial" }
      : { approved: true, reason: "test", approvalId: "allowed" }),
  };
  const runner = vi.fn(async (specs: readonly Record<string, unknown>[]) => ({ ok: true, results: specs.map(() => ({ ok: true })) }));
  const hold = createContractCheckHold({ runner, approvals, approvalRequired: true, sessionId: "test", workingDir: root,
    tool: "fusion.delegate", checks, signal });
  expect(await hold.decide(signal)).toBeUndefined();
  for (const run of [hold.runner, hold.finalRunner]) {
    const result = await runContractChecks(checks, run, { workingDir: root, signal });
    expect(result.outcomes).toMatchObject([{ ok: true }, { ok: false, artifactStatus: "uncheckable" }, { ok: true }]);
    expect(result.checksSkipped).toBeUndefined();
    expect(runner.mock.lastCall?.[0]).toEqual([command, command]);
  }
});

it("returns an uncheckable standalone result on UI approval denial", async () => {
  const { buildVerifyRunTool } = await import("./verify-run.js");
  await fake(0, []);
  const request = vi.fn(async () => ({ approved: false, reason: "denied", approvalId: "denied" }));
  const workspace = vi.fn(async () => { throw new Error("a denied check must not copy the project"); });
  const tool = buildVerifyRunTool({ approvals: { request } as never, approvalRequired: true, config: {} as never, workspace });
  const result = await tool.run({ kind: "ui", path: "index.html" }, {
    workingDir: root, sessionId: "test", stepIndex: 0, signal: new AbortController().signal,
  });
  expect(result.details).toMatchObject({ artifactStatus: "uncheckable", error: expect.stringContaining("denied") });
  expect(workspace).not.toHaveBeenCalled();
});

it.each([0, 2])("passes the approved loopback URL to impeccable (exit %i)", async exit => {
  const url = "http://127.0.0.1:8123/";
  await fake(exit, exit === 0 ? [] : [finding("low-contrast", { file: url })], "impeccable", url);
  const request = vi.fn(async () => ({ approved: true }));
  const [spec] = await authorizeVerifyBatch([{ kind: "ui", url }], {
    approvals: { request } as never, approvalRequired: true,
  }, { workingDir: root, signal: new AbortController().signal, sessionId: "test", stepIndex: 0 });
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    category: "verify_ui_detector", preview: expect.stringContaining(url),
  }), expect.anything());
  expect(await executeVerify(spec!, { workingDir: root })).toMatchObject({ artifactStatus: exit === 0 ? "pass" : "fail" });
});

it("rejects non-loopback UI URLs before authorization", async () => {
  for (const url of ["http://example.com:8123/", "http://localhost:8123/ https://example.com/",
    "http://localhost:8123@example.com/", "http://127.0.0.1/", "https://127.0.0.1:8123/"]) {
    await expect(approve({ kind: "ui", url }, root)).rejects.toThrow(/loopback/);
  }
});

it("reports a missing installed browser", async () => {
  const url = "http://localhost:8123/";
  await fake(1, undefined, "impeccable", url, "Error: No Chrome, Chromium, Edge, or Brave installation found for URL scanning. Install Google Chrome, or point IMPECCABLE_BROWSER at a Chromium-based browser executable.");
  expect(await runVerify({ kind: "ui", url }, { workingDir: root })).toMatchObject({
    artifactStatus: "uncheckable", error: expect.stringContaining("Chrome or Edge"),
  });
});

it("downgrades a file-scoped severe finding only until the operator revokes it", async () => {
  const { stateDirProjectRecords } = await import("../../session/project-decisions.js");
  const stateDir = join(root, "state");
  const records = stateDirProjectRecords(stateDir);
  const state = { gate: { kind: "none" as const }, milestones: [] };
  const projectRef = { folder: root, id: "ui-project" };
  const exception = { rule: "low-contrast", file: "index.html", reason: "Brand logo" };
  expect(records.write(root, projectRef.id, 0, state, undefined, undefined, { ...exception, allow: true }).ok).toBe(true);
  const scan = async (path: string) => {
    await fake(2, [finding("low-contrast", { file: path })]);
    const [spec] = await authorizeVerifyBatch([{ kind: "ui", path }], {
      approvals: {} as never, approvalRequired: false, uiExceptionStateDir: stateDir,
    }, { workingDir: root, signal: new AbortController().signal, sessionId: "test", stepIndex: 0, projectRef });
    return executeVerify(spec!, { workingDir: root });
  };
  expect(await scan("index.html")).toMatchObject({
    artifactStatus: "pass",
    impeccableFindings: ["warning: low-contrast — index.html (approved by the operator: Brand logo)"],
    impeccableExceptions: ["low-contrast:index.html — approved by the operator: Brand logo"],
  });
  await writeFile(join(root, "other.html"), "<p>Hello</p>");
  expect(await scan("other.html")).toMatchObject({ artifactStatus: "fail" });
  expect(records.write(root, projectRef.id, 1, state, undefined, undefined, { ...exception, allow: false }).ok).toBe(true);
  expect(await scan("index.html")).toMatchObject({ artifactStatus: "fail" });
});

it("scans the address of a named service while it is ready in the same batch", async () => {
  const { runChecks } = await import("./run-verify.js");
  const url = "http://127.0.0.1:8123/preview";
  await fake(0, [], "impeccable", url);
  const controller = new AbortController();
  const specs = [
    { kind: "service", id: "preview", start: { cmd: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, ready: { url } },
    { kind: "ui", service: "preview" },
  ];
  const { createContractCheckHold } = await import("../fusion/contract-check-hold.js");
  const hold = createContractCheckHold({
    approvals: {}, approvalRequired: false, sessionId: "test", workingDir: root,
    tool: "fusion.delegate", checks: specs, signal: controller.signal,
    runner: (batch, ctx) => runChecks(batch, { ...ctx, fetchImpl: async () => ({ status: 200, text: async () => "" }) }),
  });
  expect(await hold.finalRunner!(specs, { workingDir: root, signal: controller.signal })).toMatchObject({ ok: true, results: [{ kind: "service", ready: true }, { kind: "ui", artifactStatus: "pass" }] });
});
