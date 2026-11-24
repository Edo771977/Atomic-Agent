import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxCommand } from "./sandbox-command.js";
import { revokeWindowsSandbox } from "../sandbox/windows-sandbox.js";

vi.mock("../config/index.js", () => ({ resolveStateDir: () => "C:\\state" }));
vi.mock("../sandbox/windows-sandbox.js", () => ({ revokeWindowsSandbox: vi.fn(() => 2) }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("sandbox windows revoke", () => {
  it("passes an explicit selection to the grant registry", async () => {
    vi.stubEnv("ATOMIC_AGENT_TOOL_CHILD", undefined);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await sandboxCommand(["windows", "revoke", "--all"])).toBe(0);
    expect(revokeWindowsSandbox).toHaveBeenCalledWith("C:\\state", "--all");
    expect(output).toHaveBeenCalledWith("Revoked Windows sandbox access for 2 project(s).\n");
  });

  it("does not revoke when invoked by a tool child, even with an empty marker", async () => {
    vi.stubEnv("ATOMIC_AGENT_TOOL_CHILD", "");
    const output = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await sandboxCommand(["windows", "revoke", "C:\\project"])).toBe(1);
    expect(output).toHaveBeenCalledWith(expect.stringContaining("operator's own terminal"));
    expect(revokeWindowsSandbox).not.toHaveBeenCalled();
  });

  it("requires exactly one selection", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await sandboxCommand(["windows", "revoke"])).toBe(2);
    expect(await sandboxCommand(["windows", "revoke", "--all", "C:\\project"])).toBe(2);
    expect(revokeWindowsSandbox).not.toHaveBeenCalled();
  });
});
