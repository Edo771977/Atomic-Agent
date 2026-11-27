import { describe, expect, it } from "vitest";
import { mergePolicySources } from "./policy-loader.js";
import { parsePolicyFile } from "./policy-schema.js";
import { policyRuleMatch } from "./policy-enforce.js";

describe("organization edit policy outside workspace and home", () => {
  const policy = mergePolicySources([{ status: { kind: "system", location: "fixture", state: "loaded" },
    file: parsePolicyFile({ rules: [{ action: "edit", resource: "*", effect: "deny" }] }) }]);
  it.each(["os.fs.docx", "os.fs.xlsx", "os.fs.write_pptx", "os.fs.archive.extract"])("%s still obeys edit policy when the fork requests other approval", tool => {
    expect(policyRuleMatch(policy, { tool, category: "other", affectedResources: ["outside-file"], targetPaths: ["outside-file"] })?.decision).toBe("deny");
  });
});
