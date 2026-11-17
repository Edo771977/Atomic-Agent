import { describe, expect, it } from "vitest";

import { codingModeLook } from "./coding-mode.js";
import { codingModeApprovalNote } from "./coding-mode-approval-note.js";
import { APPROVAL_CATEGORY_LABELS, isAutoApprovedAt, type ApprovalCategory } from "../../approval/approval-level.js";

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
    expect(codingModeApprovalNote("auto", { tool: "os.fs.write", category: "fs_write_workspace" })).toBeNull();
    expect(codingModeApprovalNote("auto", { tool: "verify.run", category: "verify_page_local" })).toBeNull();
    expect(codingModeApprovalNote("auto", { tool: "os.fs.write", category: "trust_config" })).toBeNull();
  });

  it("the auto summary names what still asks", () => {
    const summary = codingModeLook("auto").summary;
    expect(summary).toContain("shell commands");
    expect(summary).toContain("verifications");
  });
});

describe("codingModeApprovalNote for the other categories auto leaves asking", () => {
  // Every category quiet at level 3 or 4 but not at 2 (auto): enumerated
  // from the ladder so a new one cannot be missed.
  const levelThreeOrFour = (Object.keys(APPROVAL_CATEGORY_LABELS) as ApprovalCategory[])
    .filter((c) => isAutoApprovedAt(4, c) && !isAutoApprovedAt(2, c) && c !== "shell");

  it("covers http, git_remote and the rest", () => {
    expect(levelThreeOrFour).toEqual(expect.arrayContaining(["http", "git_remote", "http_write", "fs_write_home", "publish", "fusion_fanout"]));
  });

  it.each(levelThreeOrFour)("names %s and the grant the prompt offers, or none", (category) => {
    const note = codingModeApprovalNote("auto", { tool: "t", category });
    expect(note).toContain(`auto mode doesn't cover ${APPROVAL_CATEGORY_LABELS[category]}`);
    if (category === "fusion_fanout") expect(note).toContain("each one asks");
    // Site-scoped grants: without a page in the request there is no site
    // to offer, so the line may say each one asks.
    else if (category === "browser_commit" || category === "browser_offsite" || category === "browser_site_tool") expect(note).toBeTruthy();
    else expect(note).toContain("ctrl+f allows it for this session");
  });

  it("names the origin of a keyed http grant", () => {
    const note = codingModeApprovalNote("auto", { tool: "os.http.request", category: "http", grantKey: "https://api.example" });
    expect(note).toContain("ctrl+f allows it to https://api.example for this session");
  });
});
