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
    expect(await (await get(harness, open.id)).json()).toEqual({ restriction: null, channelsAllowed: true });

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
      },
      channelsAllowed: true,
    });
  });

  it("says whether the chat's content may go to a chat channel (allowedEgress lists channels)", async () => {
    harness = await startTestHarness({
      constraints: {
        "<cwd>": { allowedProviders: ["local-llama"] },
        "/work/open": { allowedProviders: ["local-llama"], allowedEgress: ["channels"] },
      },
    });
    const closed = harness.runtime.createSession();
    harness.runtime.sessionStore.save(closed);
    const closedBody = await (await get(harness, closed.id)).json() as { restriction: unknown; channelsAllowed: unknown };
    expect(closedBody.restriction).not.toBeNull();
    expect(closedBody.channelsAllowed).toBe(false);

    const open = { ...harness.runtime.createSession(), workingDir: "/work/open" };
    harness.runtime.sessionStore.save(open);
    const openBody = await (await get(harness, open.id)).json() as { restriction: unknown; channelsAllowed: unknown };
    expect(openBody.restriction).not.toBeNull();
    expect(openBody.channelsAllowed).toBe(true);
  });

  it("answers 404 for a session that is not stored", async () => {
    harness = await startTestHarness();
    expect((await get(harness, "missing")).status).toBe(404);
  });
});
