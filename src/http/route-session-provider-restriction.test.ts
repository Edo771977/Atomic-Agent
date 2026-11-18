import { afterEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

/** Issue #33 group C: the provider restriction on a chat, over `serve`. */
describe("GET /api/sessions/{id}/provider-restriction", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  const get = (h: Harness, id: string) => fetch(`${h.baseUrl}/api/sessions/${id}/provider-restriction`);

  it("answers null for an unrestricted chat and the restriction for one that read a constrained folder", async () => {
    harness = await startTestHarness();
    const open = harness.runtime.createSession();
    harness.runtime.sessionStore.save(open);
    expect(await (await get(harness, open.id)).json()).toEqual({ restriction: null });

    const tainted = harness.runtime.createSession({
      metadata: { providerReadTaint: { key: "/work/secret", allowedProviders: ["local-llama"], matchedDir: "/work/secret", readFrom: ["/work/secret"] } },
    });
    harness.runtime.sessionStore.save(tainted);
    expect(await (await get(harness, tainted.id)).json()).toEqual({
      restriction: {
        label: "restricted to: local-llama",
        allowedProviders: ["local-llama"],
        folder: "/work/secret",
        readFrom: ["/work/secret"],
        movedFrom: [],
      },
    });
  });

  it("answers 404 for a session that is not stored", async () => {
    harness = await startTestHarness();
    expect((await get(harness, "missing")).status).toBe(404);
  });
});
