import { describe, expect, it, vi } from "vitest";
import { makeProviderPolicy, runWithProviderPolicy } from "../../llm/provider-policy.js";
import { EmbeddingUnavailableError, type EmbeddingClient } from "./embedding-client.js";
import { embeddingEndpointOnMachine, guardEmbeddingClient } from "./embedding-policy-guard.js";

const policy = makeProviderPolicy({ key: "/work/client", allowedProviders: ["local-llama"], matchedDir: "/work/client" });

function client(): EmbeddingClient & { embed: ReturnType<typeof vi.fn> } {
  return { dim: 2, model: "m", embed: vi.fn(async () => ({ vector: new Float32Array(2), model: "m" })) };
}

describe("memory embeddings under a folder's provider constraint (issue #33)", () => {
  it("counts loopback and Atomic Core endpoints as this machine, anything else as not", () => {
    expect(embeddingEndpointOnMachine("http://127.0.0.1:19092", false)).toBe(true);
    expect(embeddingEndpointOnMachine("http://localhost:19092", false)).toBe(true);
    expect(embeddingEndpointOnMachine("http://[::1]:19092", false)).toBe(true);
    expect(embeddingEndpointOnMachine("https://embed.example.com", false)).toBe(false);
    expect(embeddingEndpointOnMachine("http://192.168.1.20:19092", false)).toBe(false);
    expect(embeddingEndpointOnMachine("https://embed.example.com", true)).toBe(true);
    expect(embeddingEndpointOnMachine("not a url", false)).toBe(false);
  });

  it("refuses a non-loopback endpoint in a constrained folder, as an unavailable embedding, before sending", async () => {
    const inner = client();
    const guarded = guardEmbeddingClient(inner, { onMachine: false, constraintsActive: () => true });
    const run = runWithProviderPolicy(policy, () => guarded.embed({ text: "secret" }));
    await expect(run).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    await expect(runWithProviderPolicy(policy, () => guarded.embed({ text: "secret" }))).rejects.toThrow(/restricted to: local-llama/);
    expect(inner.embed).not.toHaveBeenCalled();
  });

  it("refuses a non-loopback endpoint with no frame while constraints exist", async () => {
    const inner = client();
    const guarded = guardEmbeddingClient(inner, { onMachine: false, constraintsActive: () => true });
    await expect(guarded.embed({ text: "x" })).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    expect(inner.embed).not.toHaveBeenCalled();
  });

  it("lets a loopback endpoint through in a constrained folder, and a remote one in an unconstrained folder", async () => {
    const local = client();
    await runWithProviderPolicy(policy, () =>
      guardEmbeddingClient(local, { onMachine: true, constraintsActive: () => true }).embed({ text: "x" }));
    expect(local.embed).toHaveBeenCalledTimes(1);
    const remote = client();
    await runWithProviderPolicy(undefined, () =>
      guardEmbeddingClient(remote, { onMachine: false, constraintsActive: () => true }).embed({ text: "x" }));
    expect(remote.embed).toHaveBeenCalledTimes(1);
  });
});
