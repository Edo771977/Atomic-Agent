import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { getStateSecretPaths, getTrustConfigPaths } from "./config-file.js";

describe("organization policy trust boundary", () => {
  const paths = { stateDir: join(process.cwd(), "test-state"), userConfigFile: join(process.cwd(), "test-state", "config.json"), localModelsDataDir: join(process.cwd(), "test-models") };
  it.each(["policy.json", "policy-cache.json"])("protects %s like the serve key for both reads and writes", name => {
    expect(getTrustConfigPaths(paths)).toContain(join(paths.stateDir, name));
    expect(getStateSecretPaths(paths)).toContain(join(paths.stateDir, name));
  });
});
