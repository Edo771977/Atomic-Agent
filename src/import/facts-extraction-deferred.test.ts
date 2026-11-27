import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("C3a facts extraction remains deferred", () => {
  it("exposes no export parser or collector before archive and read-scope review", () => {
    for (const file of ["user-facts/chatgpt-export.ts", "user-facts/collect-user-messages.ts"]) {
      expect(existsSync(fileURLToPath(new URL(file, import.meta.url)))).toBe(false);
    }
  });
  it("exposes no save or undo API callable with agent-supplied approval IDs", () => {
    expect(existsSync(fileURLToPath(new URL("user-facts/save-fact-candidates.ts", import.meta.url)))).toBe(false);
  });
  it("exposes no extraction engine before runtime-secret, framing and output-bound checks", () => {
    expect(existsSync(fileURLToPath(new URL("../memory/import-facts/extract-fact-candidates.ts", import.meta.url)))).toBe(false);
  });
});
