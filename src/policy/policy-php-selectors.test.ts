import { describe, expect, it } from "vitest";
import { toolCallTarget } from "./policy-targets.js";
describe("PHP CLI code selectors", () => {
  it.each(["-B", "-R", "-E"])("keeps %s code opaque", flag => {
    expect(toolCallTarget("os.shell.run", { cmd: "php", args: [flag, "fixture"] })?.unreadable).toBe(true);
    expect(toolCallTarget("os.shell.run", { cmd: "php", args: [`${flag}fixture`] })?.unreadable).toBe(true);
  });
  it("retains ordinary file and configuration operands", () => {
    expect(toolCallTarget("os.shell.run", { cmd: "php", args: ["-d", "fixture=1", "fixture.php"] })?.unreadable).not.toBe(true);
  });
});
