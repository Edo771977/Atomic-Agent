import { describe, expect, it } from "vitest";
import { toolCallTarget } from "./policy-targets.js";
describe("startup-capable Vim family names", () => {
  it.each(["vi", "view", "rvim", "rview", "gvim", "gview", "evim", "nview"])("treats %s startup as opaque", cmd => {
    expect(toolCallTarget("os.shell.run", { cmd, args: ["fixture.txt"] })?.unreadable).toBe(true);
    expect(toolCallTarget("os.shell.run", { cmd, args: ["--version"] })?.unreadable).not.toBe(true);
  });
});
