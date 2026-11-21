import { describe, expect, it } from "vitest";

import type { ContractCheck } from "./contract.js";
import { lintContractCheck } from "./contract-check-lint.js";

/** Issue #110 review: severe false refusals and weak warnings found by an adversarial review. */

const severe = (check: ContractCheck): boolean => lintContractCheck(check, 0).some((f) => f.severity === "severe");

describe("a newline separates shell commands: never a fixed print", () => {
  it.each<[string, ContractCheck]>([
    ["one-line cmd with \\n", { task: "t", cmd: "echo building\nnpm test", checks: ["exit 0"] }],
    ["one-line cmd with \\r\\n", { task: "t", cmd: "echo building\r\nnpm test", checks: ["exit 0"] }],
    ["bash -c body with \\n", { task: "t", cmd: "bash", args: ["-c", "echo ok\nnpm test"], checks: ["exit 0"] }],
    ["sh -c body with \\r", { task: "t", cmd: "sh", args: ["-c", "echo ok\rnpm test"], checks: ["exit 0"] }],
  ])("%s is not severe", (_name, check) => {
    expect(severe(check)).toBe(false);
  });
});
