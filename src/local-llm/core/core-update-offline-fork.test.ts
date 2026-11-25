import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { checkCoreUpdate } from "./core-install.js";

it("keeps a failed release check offline even when the next check is forced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "core-offline-fork-"));
  const request = vi.fn<typeof fetch>(async () => { throw new Error("fixture unavailable"); });
  vi.stubEnv("ATOMIC_AGENT_OFFLINE", undefined);
  try {
    await checkCoreUpdate(dir, request);
    expect(request).toHaveBeenCalledOnce();
    vi.stubEnv("ATOMIC_AGENT_OFFLINE", "1");
    await checkCoreUpdate(dir, request, true);
    expect(request).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
