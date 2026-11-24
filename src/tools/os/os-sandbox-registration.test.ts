import { expect, it, vi } from "vitest";
import { getConfig, getStateSecretPaths } from "../../config/index.js";
import { ApprovalGate } from "../../approval/approval-gate.js";
import { ToolRegistry } from "../tool-registry.js";
import { registerOsTools } from "./index.js";
import * as shell from "./shell/shell.js";

it("review 9: forwards the full protected state set to shell", () => {
  const config = getConfig();
  const paths = getStateSecretPaths({ ...config.paths, localModelsDataDir: "/models-fixture" });
  const build = vi.spyOn(shell, "buildOsShellTool");
  try {
    registerOsTools(new ToolRegistry(), {
      config, approvals: new ApprovalGate({ emit: () => {} }),
      approvalRequired: false, listRecentSessionDirs: () => [],
      trustConfigPaths: [config.paths.userConfigFile],
      sandboxProtectedPaths: paths,
    });
    expect(build.mock.calls[0]?.[0].protectedPaths).toEqual(paths);
    expect(paths.some(path => path.endsWith("core/chat.json") || path.endsWith("core\\chat.json"))).toBe(true);
  } finally {
    build.mockRestore();
  }
});
