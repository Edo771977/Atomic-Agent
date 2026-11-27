import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENV_SETTINGS } from "../config/env-settings.js";

describe("C4b optional vector extension and reranker remain deferred with C4a", () => {
  it("exposes no automatic native loader, vector mirror or reranker implementation", () => {
    for (const file of ["file-vec-extension", "file-vec-index", "file-rerank"]) {
      expect(existsSync(new URL(`./files/${file}.ts`, import.meta.url)), file).toBe(false);
    }
  });

  it("does not advertise the unapproved reranker environment setting", () => {
    expect(ENV_SETTINGS.some(setting => setting.name === "ATOMIC_AGENT_RERANK_URL")).toBe(false);
  });
});
