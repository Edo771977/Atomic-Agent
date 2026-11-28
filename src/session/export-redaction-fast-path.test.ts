import { afterEach, expect, it, vi } from "vitest";
import { Lexer } from "marked";
import { maskChatExportText, type ChatExportOptions } from "./chat-export.js";

afterEach(() => vi.restoreAllMocks());
const value = "OpaqueCredential731";
const options = { knownSecrets: [{ label: "fixture", value }] };
it.each(["plain\r\n\r\ntext", "<pre>\r\n\r\nliteral\r\n</pre>", "~~~fixture\r\n\r\nliteral\r\n~~~"])("normalizes CRLF before grouping export blocks: %s", text => {
  const output = maskChatExportText(text, options);
  expect(output).not.toContain("\r");
  expect(output).toBe(maskChatExportText(text.replace(/\r\n/g, "\n"), options));
});
it("never passes CRLF source to the bounded block parser", () => {
  const lex = vi.spyOn(Lexer, "lex");
  maskChatExportText("[ordinary](https://example.invalid)\r\n\r\nplain", options);
  expect(lex).toHaveBeenCalled();
  expect(lex.mock.calls.every(call => !call[0].includes("\r"))).toBe(true);
});
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
it.each(["*", "_", "`", "~", "&", "[", "\\", "<"])("keeps projection for syntax character %s", char => {
  expect(measure(`ordinary${char}text`, options).count).toBeGreaterThan(0);
});
it("keeps projection for ASCII controls that rendering can remove", () => {
  const { output, count } = measure("Opaque\u0001Credential731", options);
  expect(output).toContain("redacted");
  expect(count).toBeGreaterThan(0);
});
it("masks an escaped hyphen in a known value before document framing", () => {
  const output = maskChatExportText("sentinel\\-731key", { knownSecrets: [{ label: "fixture", value: "sentinel-731key" }] });
  expect(output).toContain("redacted");
});
