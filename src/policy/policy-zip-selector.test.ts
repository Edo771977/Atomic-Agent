import { describe, expect, it } from "vitest";
import { toolCallTarget } from "./policy-targets.js";
describe("zip custom test program selector", () => {
  it.each([["-T", "-TT", "fixture", "fixture.zip"], ["-T", "-TTfixture", "fixture.zip"]])("keeps explicit test programs opaque: %j", (...args) => {
    expect(toolCallTarget("os.shell.run", { cmd: "zip", args })?.unreadable).toBe(true);
  });
  it("retains ordinary zip and literal data after --", () => {
    expect(toolCallTarget("os.shell.run", { cmd: "zip", args: ["fixture.zip", "fixture.txt"] })?.unreadable).not.toBe(true);
    expect(toolCallTarget("os.shell.run", { cmd: "zip", args: ["--", "-TTfixture"] })?.unreadable).not.toBe(true);
  });
});
