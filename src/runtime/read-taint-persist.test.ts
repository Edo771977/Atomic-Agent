import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "../http/test-harness.js";
import { currentProviderPolicy, type ProviderPolicy } from "../llm/provider-policy.js";
import { READ_TAINT_METADATA_KEY } from "./session-read-taint.js";

/**
 * Issue #74 item 1: a read inside a constrained folder taints the
 * session for good. The turn saves a copy of the session, not the
 * object the taint was written on, so the stored row must still get it
 * (and the next turn must run under it).
 */
describe("read taint persists across HTTP turns", () => {
  let harness: Harness | undefined;
  let secret: string | undefined;
  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
    if (secret) rmSync(secret, { recursive: true, force: true });
    secret = undefined;
  });

  const answer = (content: string) => ({
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 1, predictedTokens: 1 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: null,
  });

  it("stores the taint at turn end and restricts the next turn", async () => {
    secret = mkdtempSync(join(tmpdir(), "taint-persist-secret-"));
    writeFileSync(join(secret, "plan.md"), "TOP SECRET PLAN\n");
    const bodies = [
      JSON.stringify([{ tool: "os.fs.read", args: { path: join(secret, "plan.md") } }]),
      JSON.stringify([{ tool: "reply", args: { text: "done" } }]),
    ];
    const frames: Array<ProviderPolicy | undefined> = [];
    harness = await startTestHarness({
      constraints: { [secret]: { allowedProviders: ["local-llama"], allowedEgress: [] } },
      llamaComplete: async () => {
        frames.push(currentProviderPolicy());
        return answer(bodies.shift() ?? JSON.stringify([{ tool: "reply", args: { text: "ok" } }]));
      },
    });
    const post = (content: string) =>
      fetch(`${harness!.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content }], session_id: "taint-1" }),
      });

    const first = await post("read it");
    expect(first.status).toBe(200);
    await first.text();
    const stored = harness.runtime.sessionStore.load("taint-1")!;
    expect(stored.metadata[READ_TAINT_METADATA_KEY]).toMatchObject({
      key: secret,
      allowedProviders: ["local-llama"],
      allowedEgress: [],
      readFrom: [secret],
    });
    // Unrestricted before the read; restricted from the step after it.
    expect(frames[0]).toBeUndefined();
    expect(frames[1]?.key).toBe(secret);

    const framesBefore = frames.length;
    const second = await post("next");
    expect(second.status).toBe(200);
    await second.text();
    const frame = frames[framesBefore];
    expect(frame?.key).toBe(secret);
    // A cloud provider is refused, and so is web egress.
    expect(frame?.allows("openai")).toBe(false);
    expect(frame?.allows("local-llama")).toBe(true);
    expect(frame?.allowsEgress("web")).toBe(false);
    const after = harness.runtime.sessionStore.load("taint-1")!;
    expect(harness.runtime.providerRestrictionFor?.(after)).toMatchObject({ readFrom: [secret] });
    expect(harness.runtime.egressRefusal?.(after, "web")).toContain(`folder ${secret} is restricted`);
  });

  it("stores the taint when the turn fails after the read", async () => {
    secret = mkdtempSync(join(tmpdir(), "taint-persist-secret-"));
    writeFileSync(join(secret, "plan.md"), "TOP SECRET PLAN\n");
    let calls = 0;
    harness = await startTestHarness({
      constraints: { [secret]: { allowedProviders: ["local-llama"], allowedEgress: [] } },
      llamaComplete: async () => {
        calls += 1;
        if (calls === 1) return answer(JSON.stringify([{ tool: "os.fs.read", args: { path: join(secret!, "plan.md") } }]));
        throw new Error("server went away");
      },
    });
    const res = await fetch(`${harness.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "read it" }], session_id: "taint-2" }),
    });
    await res.text();
    expect(calls).toBeGreaterThanOrEqual(2);
    const stored = harness.runtime.sessionStore.load("taint-2");
    expect(stored?.metadata[READ_TAINT_METADATA_KEY]).toMatchObject({ key: secret, readFrom: [secret] });
  });
});
