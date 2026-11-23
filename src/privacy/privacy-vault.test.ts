import * as privateDetector from "./detect-private-data.js";
import { vi } from "vitest";
import { describe, expect, it } from "vitest";

import { PrivacyVault } from "./privacy-vault.js";

describe("PrivacyVault (ATO-599)", () => {
  it("masks with stable, numbered placeholders and unmasks them back", () => {
    const vault = new PrivacyVault();
    const text = "Email jane@example.com and bob@example.org, again jane@example.com.";
    const masked = vault.mask(text);
    expect(masked).toBe("Email [EMAIL_1] and [EMAIL_2], again [EMAIL_1].");
    expect(vault.unmask(masked)).toBe(text);
    // Same value, later call: same placeholder.
    expect(vault.mask("cc jane@example.com")).toBe("cc [EMAIL_1]");
  });

  it("numbers each kind on its own", () => {
    const vault = new PrivacyVault();
    expect(vault.mask("a@b.io 4111111111111111 c@d.io")).toBe("[EMAIL_1] [CARD_1] [EMAIL_2]");
    expect(vault.stats().byKind).toMatchObject({ EMAIL: 2, CARD: 1, PHONE: 0 });
    expect(vault.stats().distinct).toBe(3);
  });

  it("keeps masking a value it has seen, even where the detector would not find it", () => {
    const vault = new PrivacyVault();
    vault.mask("API_TOKEN=Zx9vQ2mL7pR4tY8wK1nB");
    expect(vault.mask("now bare: Zx9vQ2mL7pR4tY8wK1nB")).toBe("now bare: [SECRET_1]");
  });

  it("leaves placeholders it did not mint alone", () => {
    const vault = new PrivacyVault();
    vault.mask("a@b.io");
    expect(vault.unmask("[EMAIL_1] [EMAIL_9] [FOO_1]")).toBe("a@b.io [EMAIL_9] [FOO_1]");
  });

  it("JSON-escapes restored values for tool-call arguments", () => {
    const vault = new PrivacyVault(() => [{ label: "K", value: 'pa"ss\\w0rdXYZ' }]);
    const masked = vault.mask('secret is pa"ss\\w0rdXYZ');
    expect(masked).toBe("secret is [SECRET_1]");
    const args = `{"text":"${"[SECRET_1]"}"}`;
    const restored = vault.unmask(args, { json: true });
    expect(JSON.parse(restored)).toEqual({ text: 'pa"ss\\w0rdXYZ' });
  });

  it("walks objects and arrays without mutating them", () => {
    const vault = new PrivacyVault();
    const input = { role: "user", content: [{ type: "text", text: "mail a@b.io" }], n: 1 };
    const masked = vault.maskDeep(input);
    expect(masked).toEqual({ role: "user", content: [{ type: "text", text: "mail [EMAIL_1]" }], n: 1 });
    expect(input.content[0]!.text).toBe("mail a@b.io");
    expect(vault.unmaskDeep(masked)).toEqual(input);
    // Nothing to mask: the same object back.
    const clean = { a: ["x", { b: "y" }] };
    expect(vault.maskDeep(clean)).toBe(clean);
  });

  it("counts distinct values per request and requests with something masked", () => {
    const vault = new PrivacyVault();
    const request = vault.beginRequest();
    vault.maskDeep(["a@b.io a@b.io", "c@d.io"], { request });
    vault.endRequest(request);
    expect(vault.stats()).toMatchObject({ distinct: 2, lastRequest: 2, maskedRequests: 1 });
    const empty = vault.beginRequest();
    vault.maskDeep(["nothing here"], { request: empty });
    vault.endRequest(empty);
    expect(vault.stats()).toMatchObject({ distinct: 2, lastRequest: 0, maskedRequests: 1 });
  });
});

it("keeps the reversible archive private to the vault during serialization", () => {
  const vault = new PrivacyVault();
  const value = "archive@example.test";
  vault.mask(value);
  expect(JSON.stringify(vault)).not.toContain(value);
  expect(JSON.stringify(vault.stats())).not.toContain(value);
  expect(Object.keys(vault)).not.toEqual(expect.arrayContaining(["byValue", "byPlaceholder", "reapply"]));
});

it("round-trips a literal placeholder without substituting an email into replayed text", () => {
  const vault = new PrivacyVault();
  const email = "me@private.test";
  const realReference = vault.mask(email);
  const literal = "Write the string [EMAIL_1] to the file";
  const maskedLiteral = vault.mask(literal);
  expect(vault.unmask(maskedLiteral)).toBe(literal);
  expect(vault.unmask(realReference)).toBe(email);
  expect(vault.mask(literal)).toBe(maskedLiteral);
});

it("counts interleaved requests independently", () => {
  const vault = new PrivacyVault();
  const first = vault.beginRequest();
  const second = vault.beginRequest();
  vault.maskDeep(["first@example.test", "other@example.test"], { request: first });
  vault.maskDeep(["second@example.test"], { request: second });
  vault.endRequest(first);
  expect(vault.stats()).toMatchObject({ lastRequest: 2, maskedRequests: 1 });
  vault.endRequest(second);
  expect(vault.stats()).toMatchObject({ lastRequest: 1, maskedRequests: 2 });
});

it("reuses a masked string and invalidates it when a new value is learned", () => {
  const vault = new PrivacyVault();
  const scan = vi.spyOn(privateDetector, "findPrivateSpans");
  const original = "cached context with Zq8vLp3mWx7tRb2n";
  try {
    expect(vault.maskDeep([original])).toEqual([original]);
    expect(vault.maskDeep([original])).toEqual([original]);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(vault.mask("API_KEY=Zq8vLp3mWx7tRb2n")).toBe("API_KEY=[SECRET_1]");
    expect(vault.maskDeep([original])).toEqual(["cached context with [SECRET_1]"]);
  } finally {
    scan.mockRestore();
  }
});

it("stops before sending data it cannot retain in the archive", () => {
  const vault = new PrivacyVault();
  const secret = "A9".repeat(1024 * 1024);
  expect(() => vault.mask(secret, [{ label: "oversized", value: secret }])).toThrow(/Privacy Shield archive limit/);
});

it("does not reapply a value inside a reference it just created", () => {
  const vault = new PrivacyVault();
  expect(vault.mask("password=SECRET_1")).toBe("password=[SECRET_1]");
});

it("discovers an assignment before masking the earlier bare occurrence in the same request", () => {
  const input = ["use Zq8vLp3mWx7tRb2n", "DB_PASSWORD=Zq8vLp3mWx7tRb2n"];
  const cold = new PrivacyVault();
  const warm = new PrivacyVault();
  warm.mask(input[1]!);
  expect(JSON.stringify(cold.maskDeep(input))).toBe(JSON.stringify(warm.maskDeep(input)));
  expect(cold.maskDeep(input)).toEqual(["use [SECRET_1]", "DB_PASSWORD=[SECRET_1]"]);
});
