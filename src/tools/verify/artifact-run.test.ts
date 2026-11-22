import { spawn } from "node:child_process";
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApprovalGate } from "../../approval/approval-gate.js";
import { runVerify } from "./run-verify.js";
import { parseVerifyRunArgs } from "./verify-run-args.js";
import { authorizeVerifyBatch } from "./verify-authorization.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "verify-artifact-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it.each(["document", "spreadsheet"])("checks read scope before approving %s", async kind => {
  const checkReadTargets = vi.fn(async () => ({ tool: "verify.run", status: "error" as const, summary: "read denied", details: {}, truncated: false }));
  await expect(authorizeVerifyBatch([{kind, path: kind === "document" ? "note.md" : "data.csv"}],
    { approvals: {} as never, approvalRequired: false, checkReadTargets },
    { workingDir: dir, sessionId: "test", stepIndex: 0, signal: new AbortController().signal }
  )).rejects.toThrow("read denied");
  expect(checkReadTargets).toHaveBeenCalledOnce();
});

it("refuses network and filenames outside the project", () => {
  for (const spec of [{ path: "../outside.txt" }, { path: "ok.txt", network: true }]) {
    expect(() => parseVerifyRunArgs({ kind: "document", ...spec })).toThrow();
  }
});

it("shows the scoped file and offline reader in the approval request", async () => {
  const request = vi.fn(async () => ({ approved: true, reason: "test" }));
  const checkReadTargets = vi.fn(async () => null);
  const signal = new AbortController().signal;
  const target = join(dir, "reports", "note.txt");
  await authorizeVerifyBatch([{ kind: "document", cwd: "reports", path: "note.txt" }], {
    approvals: { request } as unknown as ApprovalGate,
    approvalRequired: true,
    checkReadTargets,
  }, { workingDir: dir, sessionId: "test", stepIndex: 0, signal });
  expect(checkReadTargets).toHaveBeenCalledWith("verify.run", { path: target }, expect.anything(), "os.fs.read");
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    affectedResources: [target],
    category: "shell",
    preview: expect.stringContaining("offline parser"),
  }), { signal });
});

it("validates and opens the approved cwd-relative file without following hard links", async () => {
  const reports = join(dir, "reports");
  await mkdir(reports);
  const note = join(reports, "note.txt");
  await writeFile(note, "A short document.");
  const run = (path: string) => runVerify({ kind: "document", cwd: "reports", path }, { workingDir: dir });
  expect(await run("note.txt")).toMatchObject({ ok: true, artifactStatus: "pass" });
  await link(note, join(reports, "alias.txt"));
  expect(await run("alias.txt")).toMatchObject({ ok: false, artifactStatus: "uncheckable" });
});

it("never passes a missing, oversized or timed-out artifact even with no assertions", async () => {
  const run = (path: string, timeoutMs = 10000) => runVerify({ kind: "document", path, timeoutMs }, { workingDir: dir });
  expect((await run("missing.txt")).ok).toBe(false);
  await writeFile(join(dir, "big.txt"), Buffer.alloc(9 * 1024 * 1024));
  expect(await run("big.txt")).toMatchObject({ ok: false, artifactStatus: "uncheckable" });
  await writeFile(join(dir, "ok.txt"), "A short document.");
  expect(await run("ok.txt", 1)).toMatchObject({ ok: false, artifactStatus: "uncheckable", timedOut: true });
});

it("stops an in-flight parser and marks cancellation", async () => {
  const controller = new AbortController();
  await writeFile(join(dir, "note.txt"), "A short document.");
  const result = runVerify({ kind: "document", path: "note.txt" }, { workingDir: dir, signal: controller.signal });
  controller.abort();
  expect(await result).toMatchObject({ ok: false, errorCode: "cancelled" });
});

it("refuses to parse an artifact when the offline process restrictions are missing", async () => {
  await writeFile(join(dir, "note.txt"), "A short document.");
  const entry = new URL("./artifact-reader.ts", import.meta.url).href;
  const child = spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e",
    "const reader = await import(process.argv[1]); process.exitCode = await reader.serveArtifactCheck();", entry,
  ], {
    env: { ...process.env, NODE_OPTIONS: "" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    timeout: 4_000,
    windowsHide: true,
  });
  const outcome = await new Promise((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`artifact reader exited with code ${code}`)));
    child.send({ root: dir, cwd: "", path: "note.txt", kind: "document", spec: {} });
  });
  expect(outcome).toMatchObject({ status: "uncheckable", detail: "offline artifact reader restrictions are unavailable" });
});
