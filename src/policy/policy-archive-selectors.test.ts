import { describe, expect, it } from "vitest";
import { toolCallTarget } from "./policy-targets.js";
describe("tar short and old-style external program selectors", () => {
  it.each(["cIf", "-cIf"])("keeps %s compressor programs opaque", flags => {
    expect(toolCallTarget("os.shell.run", { cmd: "tar", args: [flags, "fixture", "fixture.tar", "fixture.txt"] })?.unreadable).toBe(true);
  });
  it("retains ordinary archiving and data containing I", () => {
    expect(toolCallTarget("os.shell.run", { cmd: "tar", args: ["-cf", "fixtureI.tar", "fixture.txt"] })?.unreadable).not.toBe(true);
  });
});
