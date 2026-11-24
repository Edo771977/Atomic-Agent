import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";

it("review 13: disabled shell descriptor matches main byte for byte", async () => {
  vi.stubEnv("ATOMIC_AGENT_SANDBOX", "off");
  vi.resetModules();
  try {
    const { getToolDescriptorByName } = await import("./tool-descriptors.js");
    const serialized = JSON.stringify(getToolDescriptorByName("os.shell.run"));
    // Includes the description, text and JSON schemas and compact projection from main e75998c51.
    expect(createHash("sha256").update(serialized).digest("hex")).toBe(
      "da08e662b8467582023eb6c2fb0ce4bfeed89de26ee4193f7606048c079e4aff",
    );
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
});
