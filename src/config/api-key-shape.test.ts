import { describe, expect, it } from "vitest";

import { describeMalformedApiKey } from "./api-key-shape.js";

describe("describeMalformedApiKey", () => {
  it("flags the placeholders our own docs and common templates use", () => {
    for (const v of ["...", "…", "<key>", "<your-api-key>", "sk-ant-...", "your-key", "YOUR_API_KEY", "paste-your-key-here", "xxxx", "changeme"]) {
      expect(describeMalformedApiKey(v), v).toMatch(/placeholder/);
    }
  });

  it("flags whitespace inside a key", () => {
    expect(describeMalformedApiKey("sk-ant-abc def-0123456789")).toMatch(/whitespace/);
  });

  it("flags a too-short key only under the strict cloud rule", () => {
    expect(describeMalformedApiKey("sk-personal", { strictLength: true })).toMatch(/too short/);
    expect(describeMalformedApiKey("sk-personal")).toBeNull();
  });

  it("accepts real-looking keys and short local-server keys", () => {
    expect(describeMalformedApiKey("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123", { strictLength: true })).toBeNull();
    expect(describeMalformedApiKey("lm-studio")).toBeNull();
    expect(describeMalformedApiKey("sk-secret")).toBeNull();
  });
});
