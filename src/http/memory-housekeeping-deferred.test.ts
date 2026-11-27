import { describe, expect, it } from "vitest";
import { MemoryStore } from "../memory/memory-store.js";
import { ROUTE_SCOPES } from "./http-scopes.js";
import { startTestHarness } from "./test-harness.js";

describe("B7a1 deferred housekeeping restore", () => {
  it.each(["lesson", "procedure"])("keeps %s history unavailable", async kind => {
    const harness = await startTestHarness();
    try {
      const response = await fetch(`${harness.baseUrl}/api/memory/changes?kind=${kind}`);
      expect(response.status).toBe(400);
    } finally { await harness.cleanup(); }
  });
  it("keeps housekeeping mutation methods absent from the note owner", () => {
    expect("unarchive" in MemoryStore.prototype).toBe(false);
    expect("setTags" in MemoryStore.prototype).toBe(false);
  });
  it("retains the existing history scopes without enabling new restore kinds", () => {
    expect(ROUTE_SCOPES["GET /api/memory/changes"]).toBe("read");
    expect(ROUTE_SCOPES["POST /api/memory/changes/{id}/restore"]).toBe("admin");
    expect(ROUTE_SCOPES["POST /api/memory/profile/{key}/restore"]).toBe("admin");
  });
});
