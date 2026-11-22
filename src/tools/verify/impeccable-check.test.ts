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
  vi.stubEnv("PATH", bin);
  await writeFile(join(root, "style.css"), "/* impeccable-disable-next-line low-contrast */\np { color: #aaa; }");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function fake(exit: number, payload: unknown, name = "impeccable") {
  const script = join(bin, `${name}.cjs`);
  await writeFile(script, `
    const args = process.argv.slice(2);
    if (args[0] === "--version") console.log("impeccable 1.2.3");
    else if (args.join(" ") === "detect --json --no-config ./input.css") {
      console.log(${JSON.stringify(JSON.stringify(payload))});
      process.exitCode = ${exit};
    } else process.exitCode = 99;
  `);
  const launcher = windows ? `@"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`;
  await writeFile(join(bin, windows ? `${name}.cmd` : name), launcher, { mode: 0o700 });
}

const check = () => runVerify({ kind: "ui", path: "style.css" }, { workingDir: root });

it("fails on a severe rule and records its source file, CLI version and suppression", async () => {
  await fake(2, [{ antipattern: "low-contrast", file: "./input.css" }]);
  const result = await check();
  expect(result).toMatchObject({ ok: false, artifactStatus: "fail", impeccableVersion: "impeccable 1.2.3" });
  expect(result.stdoutTail).toContain("low-contrast — style.css");
  expect(result.stdoutTail).toContain("style.css:1: impeccable-disable-next-line");
});

it("retains warning-only findings on a pass", async () => {
  await fake(2, [{ antipattern: "bounce-easing", file: "./input.css" }]);
  expect(await check()).toMatchObject({ ok: true, artifactStatus: "pass", stdoutTail: expect.stringContaining("bounce-easing — style.css") });
});

it.each([[1, { filesScanned: 1, findings: [] }], [0, { filesScanned: 0, findings: [] }], [0, []]])(
  "returns uncheckable for exit %i without confirmed coverage", async (exit, payload) => {
    await fake(exit, payload);
    expect(await check()).toMatchObject({ ok: false, artifactStatus: "uncheckable", impeccableVersion: "impeccable 1.2.3" });
  },
);

it("passes a clean scan with a positive JSON file count", async () => {
  await fake(0, { filesScanned: 1, findings: [] });
  expect(await check()).toMatchObject({ ok: true, artifactStatus: "pass" });
});

it("returns uncheckable without executing a package runner when impeccable is absent", async () => {
  const marker = join(root, "runner-used");
  await writeFile(join(bin, windows ? "npx.cmd" : "npx"), windows
    ? `@echo used>"${marker}"\r\n` : `#!/bin/sh\nprintf used > '${marker}'\n`, { mode: 0o700 });
  expect(await check()).toMatchObject({ ok: false, artifactStatus: "uncheckable", error: expect.stringContaining("impeccable non installato") });
  await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it("runs through Fusion, preserving the evidence and failing the linked criterion", async () => {
  const { runContractChecks } = await import("../fusion/contract-checks.js");
  const { criteriaFactsFor, taskCriteria } = await import("../fusion/criteria-facts.js");
  const { runChecks } = await import("./run-verify.js");
  await fake(2, [{ antipattern: "low-contrast", file: "./input.css" }]);
  const contract = { checks: [{ task: "design", kind: "ui", path: "style.css", criteria: ["contrast"] }] };
  const brief = new Map([["contrast", { id: "contrast", text: "Readable text contrast" }]]);
  const { outcomes } = await runContractChecks(contract.checks, runChecks, { workingDir: root, signal: new AbortController().signal });
  expect(outcomes).toEqual([expect.objectContaining({
    task: "design",
    ok: false,
    criteria: ["contrast"],
    impeccableFindings: ["severe: low-contrast — style.css"],
    impeccableSuppressions: ["style.css:1: impeccable-disable-next-line"],
  })]);
  expect(criteriaFactsFor(taskCriteria("design", contract, brief), contract, outcomes, undefined))
    .toMatchObject([{ id: "contrast", state: "failed" }]);
});

it("refuses network and checks read scope before asking for approval", async () => {
  const { authorizeVerifyBatch } = await import("./verify-authorization.js");
  const ctx = { workingDir: root, sessionId: "test", stepIndex: 0, signal: new AbortController().signal };
  const checkReadTargets = vi.fn(async () => ({ tool: "verify.run", status: "error" as const, summary: "read denied", details: {}, truncated: false }));
  const options = { approvals: {} as never, approvalRequired: false, checkReadTargets };
  await expect(authorizeVerifyBatch([{ kind: "ui", path: "style.css", network: true }], options, ctx)).rejects.toThrow("do not accept network");
  expect(checkReadTargets).not.toHaveBeenCalled();
  await expect(authorizeVerifyBatch([{ kind: "ui", path: "style.css" }], options, ctx)).rejects.toThrow("read denied");
  expect(checkReadTargets).toHaveBeenCalledWith("verify.run", { path: join(root, "style.css") }, expect.anything(), "os.fs.read");
});

it("honors the deadline for a stalled detector", async () => {
  await fake(2, []);
  const script = join(bin, "impeccable.cjs");
  await writeFile(script, 'if (process.argv[2] === "--version") console.log("1.2.3"); else setInterval(() => {}, 100);');
  const result = await runVerify({ kind: "ui", path: "style.css", timeoutMs: 500 }, { workingDir: root });
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
  const result = runVerify({ kind: "ui", path: "style.css" }, { workingDir: root, signal: controller.signal });
  try {
    await vi.waitFor(() => access(marker), { timeout: 3_000 });
  } finally {
    controller.abort();
  }
  expect(await result).toMatchObject({ ok: false, artifactStatus: "uncheckable", errorCode: "cancelled" });
});
