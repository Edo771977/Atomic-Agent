import { describe, expect, it } from "vitest";

import { codingModeLook } from "./coding-mode.js";
import { codingModeApprovalNote } from "./coding-mode-approval-note.js";

describe("codingModeApprovalNote", () => {
  it("tells an auto-mode operator that verification commands are not covered", () => {
    const note = codingModeApprovalNote("auto", { tool: "verify.run", category: "shell" });
    expect(note).toContain("auto mode doesn't cover verification commands");
    expect(note).toContain("ctrl+f allows shell commands for this session");
  });

  it("says the same for a plain shell command, which auto does not cover either", () => {
    const note = codingModeApprovalNote("auto", { tool: "os.shell.run", category: "shell" });
    expect(note).toContain("auto mode doesn't cover shell commands");
    expect(note).toContain("ctrl+f");
  });

  it("does not offer ctrl+f for a risky command, which is never granted", () => {
    const note = codingModeApprovalNote("auto", { tool: "verify.run", category: "shell_dangerous" });
    expect(note).toContain("auto mode doesn't cover");
    expect(note).not.toContain("ctrl+f");
  });

  it("is silent outside auto and for categories auto does cover", () => {
    expect(codingModeApprovalNote("default", { tool: "verify.run", category: "shell" })).toBeNull();
    expect(codingModeApprovalNote("bypass", { tool: "os.shell.run", category: "shell" })).toBeNull();
    expect(codingModeApprovalNote("auto", { tool: "os.fs.write", category: "fs_write_home" })).toBeNull();
  });

  it("the auto summary names what still asks", () => {
    const summary = codingModeLook("auto").summary;
    expect(summary).toContain("shell commands");
    expect(summary).toContain("verifications");
  });
});
