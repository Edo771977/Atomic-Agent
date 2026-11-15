import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectTrustRecord } from "../config/skills-config.js";
import { isProjectFolderTrusted, trustKey } from "./project-trust.js";

describe("isProjectFolderTrusted (language server start, ATO-503)", () => {
  let dir: string;
  // A directory is not a readable config file, so the startup records apply.
  let configFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-trust-"));
    configFile = dir;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function record(over: Partial<ProjectTrustRecord>): ProjectTrustRecord[] {
    return [{
      workingDir: trustKey(dir)!,
      trustedSkills: [],
      declinedSkills: [],
      trustedInstructions: [],
      declinedInstructions: [],
      ...over,
    }];
  }

  it("counts a trusted project skill", () => {
    expect(isProjectFolderTrusted(configFile, record({ trustedSkills: ["lint"] }), dir)).toBe(true);
  });

  it("does not count a trusted instruction file alone: reading AGENTS.md is not running the folder's tsserver plugins", () => {
    expect(isProjectFolderTrusted(configFile, record({ trustedInstructions: ["AGENTS.md"] }), dir)).toBe(false);
  });

  it("does not count a folder with no answers", () => {
    expect(isProjectFolderTrusted(configFile, [], dir)).toBe(false);
  });
});
