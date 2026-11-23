import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { resolveVerifyCwd } from "./verify-authorization.js";

it.skipIf(process.platform === "win32")("review 3: refuses a symlink leaving the authorized root", () => {
  const fixture = mkdtempSync(join(tmpdir(), "atomic-cwd-"));
  try {
    const root = join(fixture, "root");
    mkdirSync(root);
    symlinkSync(fixture, join(root, "link"));
    vi.stubEnv("ATOMIC_AGENT_SANDBOX", "workspace");
    expect(() => resolveVerifyCwd(root, "link")).toThrow("inside the working directory");
  } finally {
    vi.unstubAllEnvs();
    rmSync(fixture, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "win32")("rejects an external junction and accepts an internal path with Windows aliases", () => {
  const fixture = mkdtempSync(join(tmpdir(), "atomic-cwd-junction-"));
  try {
    const root = join(fixture, "Authorized Workspace");
    const inside = join(root, "Nested Directory");
    const outside = join(fixture, "External Workspace");
    mkdirSync(inside, { recursive: true });
    mkdirSync(join(outside, "child"), { recursive: true });
    symlinkSync(outside, join(root, "junction"), "junction");

    // The containment check also applies when the command sandbox is off.
    vi.stubEnv("ATOMIC_AGENT_SANDBOX", "off");
    expect(() => resolveVerifyCwd(root, "junction\\child")).toThrow("inside the working directory");

    const alternateDriveCase = inside.replace(/^[A-Z]:/i, drive =>
      drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase());
    expect(resolveVerifyCwd(root, alternateDriveCase.replaceAll("\\", "/"))).toBe(realpathSync.native(inside));
  } finally {
    vi.unstubAllEnvs();
    rmSync(fixture, { recursive: true, force: true });
  }
});

// The Linux launcher is covered by Bubblewrap CI. Windows runs the cwd cases.
it.skipIf(process.platform !== "linux")("CI regression: supervisor does not depend on reading its host checkout in Bubblewrap", async () => {
  const { linuxServiceInvocation } = await import("./linux-service-probe.js");
  const result = linuxServiceInvocation({
    command: "/bin/true", args: [], commandLine: "true", windowsVerbatimArguments: false,
  }, "/tmp/fixture.sock");
  expect(result.args.some(arg => arg.startsWith("data:text/javascript;base64,"))).toBe(true);
});
