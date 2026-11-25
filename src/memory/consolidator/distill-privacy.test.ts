import { afterEach, expect, it } from "vitest";
import { OpenAiProvider } from "../../llm/provider/openai/openai-provider.js";
import { resetPrivacyVaults, privacyShieldTotals } from "../../privacy/index.js";
import { DistillRunner } from "./distill-runner.js";
import type { MemoryEntry } from "../memory-store.js";

afterEach(resetPrivacyVaults);
it.each([false, true])("isolates consolidator clusters, overlapping=%s", async overlap => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const hold = new Promise<void>(r => { release = r; });
  const partitions: string[] = [];
  const provider = new OpenAiProvider({ id: "cloud", baseUrl: "https://fixture.invalid", apiKey: "", defaultChatModel: "fixture", privacy: { shield: "on" },
    fetchImpl: (async (_url, init) => {
      const wire = String(init?.body);
      expect(wire).not.toContain("cluster.owner@example.test");
      if (wire.includes("SEED")) { entered(); if (overlap) await hold; }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'LESSON activation="Contact owner"; principle="Contact [EMAIL_1] for release details."; tags=release' }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  const runner = new DistillRunner({ llmComplete: async p => { partitions.push(p.sessionId); return provider.complete(p); }, slotId: -1, timeoutMs: 5000 });
  const run = (content: string) => runner.distill({ sessionId: "consolidator", episodes: [{ id: 1, content, tags: [], createdAt: 0, updatedAt: 0, source: "agent", sessionId: null, workingDir: null, recallCount: 0, lastRecalledAt: null } satisfies MemoryEntry], sharedTags: [], signal: new AbortController().signal });
  const first = run("SEED cluster.owner@example.test");
  await started;
  if (!overlap) await first;
  try {
    const next = await run("PROBE public release advice");
    expect(next.kind).toBe("ok");
    expect(JSON.stringify(next)).toContain("[EMAIL_1]");
    expect(JSON.stringify(next)).not.toContain("cluster.owner@example.test");
  } finally { release(); expect(JSON.stringify(await first)).toContain("cluster.owner@example.test"); }
  expect(partitions).toEqual(["consolidator", "consolidator"]);
  expect(privacyShieldTotals()).toEqual({ masked: 0, sessions: 0 });
});
