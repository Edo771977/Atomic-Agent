import { expect, it } from "vitest";
import { isEditableMemoryText, operatorMemoryText } from "./memory-operator-view.js";

it.each([0x200e, 0x200f, 0x061c, 0x2028, 0x2029, 0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, 0xfff9, 0xfffa, 0xfffb, 0x0378])(
  "escapes and rejects unsafe memory character %i",
  (code) => {
    const text = "left" + String.fromCodePoint(code) + "right";
    const escaped = "left\\u{" + code.toString(16).toUpperCase() + "}right";
    expect(operatorMemoryText(text)).toBe(escaped);
    expect(isEditableMemoryText(text)).toBe(false);
    expect(isEditableMemoryText(escaped)).toBe(false);
  },
);

it("rejects modified copies containing a display-only redaction marker", () => {
  expect(isEditableMemoryText("token [redacted] end!", "token original end", "token [redacted] end")).toBe(false);
  expect(isEditableMemoryText("token [redacted] end!", "token [redacted] end", "token [redacted] end")).toBe(true);
});

it("rejects ambiguous marker edits when the original contained a literal marker", () => {
  const original = "literal [redacted], private value";
  const displayed = "literal [redacted], private [redacted]";
  expect(isEditableMemoryText(displayed, original, displayed)).toBe(false);
  expect(isEditableMemoryText("literal [redacted], replacement", original, displayed)).toBe(false);
  expect(isEditableMemoryText("replacement", original, displayed)).toBe(true);
});

it("refuses any marker copied from a fully redacted view", () => {
  expect(isEditableMemoryText("[redacted]", "literal [redacted] and private", "[redacted]")).toBe(false);
  expect(isEditableMemoryText("new [redacted:other]", "literal [redacted] and private", "[redacted]")).toBe(false);
});
