import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

/**
 * Issue #74: a team member the live config does not list, or a body that
 * is not a JSON object, is the client's mistake: 400 with the param, not 500.
 */
describe("chat completions body validation", () => {
  let h: Harness;
  beforeEach(async () => { h = await startTestHarness(); });
  afterEach(async () => { await h.cleanup(); });

  const post = (body: string) => fetch(`${h.baseUrl}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });

  for (const [extra, param] of [
    [{ director: "cloud:nope" }, "director"],
    [{ reviewer: "none" }, "reviewer"],
    [{ worker: "a:b", stream: true }, "worker"],
  ] as const) {
    it(`refuses ${JSON.stringify(extra)} with 400 param ${param}`, async () => {
      const r = await post(JSON.stringify({ messages: [{ role: "user", content: "hi" }], ...extra }));
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: { param: string } }).error.param).toBe(param);
    });
  }

  for (const body of ["null", "[]", "42", "\"x\""]) {
    it(`refuses the body ${body} with 400`, async () => {
      expect((await post(body)).status).toBe(400);
    });
  }
});
