import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, resetConfigCache } from "./index.js";

describe("projects.constraints in the runtime config (issue #33)", () => {
  let dir: string | undefined;
  const prior = process.env.ATOMIC_AGENT_STATE_DIR;
  afterEach(() => {
    if (prior === undefined) delete process.env.ATOMIC_AGENT_STATE_DIR;
    else process.env.ATOMIC_AGENT_STATE_DIR = prior;
    resetConfigCache();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("keeps each entry's allowedEgress, so a listed class is actually allowed", () => {
    dir = mkdtempSync(join(tmpdir(), "atomic-constraints-"));
    process.env.ATOMIC_AGENT_STATE_DIR = dir;
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      projects: { roots: [], constraints: { "/work/client": { allowedProviders: ["local-llama"], allowedEgress: ["channels", "github"] }, "/work/vault": { allowedProviders: [] } } },
    }));
    resetConfigCache();
    const config = loadConfig();
    expect(config.projects.constraints["/work/client"]).toEqual({ allowedProviders: ["local-llama"], allowedEgress: ["channels", "github"] });
    expect(config.projects.constraints["/work/vault"]).toEqual({ allowedProviders: [] });
  });
});
