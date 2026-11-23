import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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
