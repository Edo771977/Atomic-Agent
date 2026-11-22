import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runVerify } from "./run-verify.js";

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

async function fake(exit: number, payload: unknown, name = "impeccable") {
  const script = join(bin, `${name}.cjs`);
  await writeFile(script, `
    const args = process.argv.slice(2);
    if (args[0] === "--version") console.log("impeccable 1.2.3");
    else if (args.slice(0, 3).join(" ") === "detect --json --no-config" && args.length === 4) {
      const fs = require("node:fs");
      const path = require("node:path");
      if (!fs.readFileSync(path.join(path.dirname(args[3]), "style.css"), "utf8").includes("#aaa")) process.exit(97);
      if (process.env.DO_NOT_TRACK !== "1") process.exit(98);
      if (${payload !== undefined}) console.log(${JSON.stringify(JSON.stringify(payload))});
      process.exitCode = ${exit};
    } else process.exitCode = 99;
  `);
  const launcher = windows ? `@"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`;
  await writeFile(join(bin, windows ? `${name}.cmd` : name), launcher, { mode: 0o700 });
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
  const { outcomes } = await runContractChecks(contract.checks, runChecks, { workingDir: root, signal: new AbortController().signal });
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
