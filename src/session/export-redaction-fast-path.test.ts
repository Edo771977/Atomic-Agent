import { afterEach, expect, it, vi } from "vitest";
import { maskChatExportText, type ChatExportOptions } from "./chat-export.js";

afterEach(() => vi.restoreAllMocks());
const value = "OpaqueCredential731";
const options = { knownSecrets: [{ label: "fixture", value }] };
function measure(text: string, opts: ChatExportOptions) {
  const normalizations = vi.spyOn(String.prototype, "normalize");
  const output = maskChatExportText(text, opts);
  const count = normalizations.mock.calls.length;
  normalizations.mockRestore();
  return { output, count };
}

it("skips projection for plain ASCII but still masks exact known values", () => {
  const { output, count } = measure(`value ${value}`, options);
  expect(output).not.toContain(value);
  expect(output).toContain("redacted");
  expect(count).toBe(0);
});
it("skips projection for plain ASCII but preserves the normal credential detector", () => {
  const { output, count } = measure("Authorization: Bearer abcDEFghijkLMN0123456789abcdEF", { knownSecrets: [] });
  expect(output).toContain("redacted");
  expect(output).not.toContain("abcDEFghijkLMN0123456789abcdEF");
  expect(count).toBe(0);
});
it.each(["*", "_", "`", "~", "&", "["])("keeps projection for syntax character %s", char => {
  expect(measure(`ordinary${char}text`, options).count).toBeGreaterThan(0);
});
it("keeps projection for ASCII controls that rendering can remove", () => {
  const { output, count } = measure("Opaque\u0001Credential731", options);
  expect(output).toContain("redacted");
  expect(count).toBeGreaterThan(0);
});
