import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LlmProvider, VisionRequest } from "../../llm/index.js";
import type { LlmProviderConfigEntry } from "../../llm/provider/registry/provider-types.js";
import { buildFusionVisionJudge } from "./fusion-vision-judge.js";

function provider(id: string, vision: boolean, chatModelId = "model-a"): LlmProvider & { calls: VisionRequest[] } {
  const calls: VisionRequest[] = [];
  return {
    id, name: id, chatModelId, calls,
    capabilities: { vision, visionSource: "config.provider" },
    describeImage: async (request: VisionRequest) => {
      calls.push(request);
      return { text: "[]", durationMs: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
  } as unknown as LlmProvider & { calls: VisionRequest[] };
}

const dir = mkdtempSync(join(tmpdir(), "fusion-vision-"));
const shot = join(dir, "ui-1.jpg");
writeFileSync(shot, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

describe("the fusion vision judge's runtime seam (issue #40)", () => {
  const entries: LlmProviderConfigEntry[] = [
    { id: "cloud", kind: "openai-compatible", baseUrl: "https://api.example.com", userModels: [{ id: "model-b", supportsVision: true }, { id: "model-t", supportsVision: false }] } as unknown as LlmProviderConfigEntry,
    { id: "local", kind: "llama-server" } as unknown as LlmProviderConfigEntry,
  ];
  const cloud = provider("cloud", false);
  const variant = provider("cloud", true, "model-b");
  const local = provider("local", true, "gemma");
  const registry = {
    getProvider: (id: string) => (id === "cloud" ? cloud : id === "local" ? local : undefined),
    modelVariant: vi.fn(async (_id: string, model: string) => (model === "model-b" ? variant : undefined)),
  };
  const judge = buildFusionVisionJudge({
    providerRegistry: registry,
    providerEntries: () => entries,
    routeProvider: () => local,
    assertAllowed: (id) => { if (id === "blocked") throw new Error("provider blocked is not allowed in this folder"); },
  });

  it("answers whether a member sees from its provider and model", () => {
    expect(judge.sees({ providerId: "cloud", model: "model-b", ref: "cloud:model-b" })).toBe(true);
    expect(judge.sees({ providerId: "cloud", model: "model-t", ref: "cloud:model-t" })).toBe(false);
    expect(judge.sees({ providerId: "local", model: "gemma", ref: "local:gemma" })).toBe(true);
    expect(judge.sees({ providerId: "absent", model: "x", ref: "absent:x" })).toBe(false);
  });

  it("names the vision route's provider as a member", () => {
    expect(judge.route()).toEqual({ providerId: "local", model: "gemma", ref: "local:gemma" });
  });

  it("describes on the member's own model, through its model copy, with the screenshots read", async () => {
    const out = await judge.describe({ providerId: "cloud", model: "model-b", prompt: "judge", imagePaths: [shot], maxTokens: 100, signal: new AbortController().signal });
    expect(registry.modelVariant).toHaveBeenCalledWith("cloud", "model-b");
    expect(variant.calls[0]).toMatchObject({ prompt: "judge", model: "model-b", maxTokens: 100 });
    expect(variant.calls[0]!.images[0]!.mimeType).toBe("image/jpeg");
    expect(out.usage).toMatchObject({ totalTokens: 2 });
  });

  it("refuses a provider the folder's policy does not allow before anything is read or sent", async () => {
    await expect(judge.describe({ providerId: "blocked", prompt: "p", imagePaths: [shot], maxTokens: 1, signal: new AbortController().signal })).rejects.toThrow(/not allowed/);
  });
});
