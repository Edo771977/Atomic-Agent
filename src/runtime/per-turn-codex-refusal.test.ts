import { describe, expect, it, vi } from "vitest";
import { perTurnModelRefusal } from "./per-turn-model.js";
import type { ResolvedLlmConfig } from "../llm/provider/registry/provider-types.js";

describe("W4.2 Codex CLI turn model", () => {
  const config = { activeTextProvider: "codex", activeEmbeddingProvider: "codex", toolTransport: "auto", providers: [
    { id: "codex", kind: "subscription-cli", subscriptionCli: { cli: "codex" }, defaultChatModel: "base", userModels: [{ id: "other" }] },
    { id: "claude", kind: "subscription-cli", subscriptionCli: { cli: "claude" }, defaultChatModel: "base", userModels: [{ id: "other" }] },
    { id: "cloud", kind: "openai-compatible", baseUrl: "https://cloud.example", defaultChatModel: "base", userModels: [{ id: "other" }] },
  ] } as unknown as ResolvedLlmConfig;
  it("refuses even a known Codex model before a client can run", () => {
    const launch = vi.fn();
    const run = () => {
      const refusal = perTurnModelRefusal(config, "codex", "other", { fusionWorker: true });
      if (refusal) throw new Error(refusal);
      launch();
    };
    expect(run).toThrow(/Codex CLI/);
    expect(launch).not.toHaveBeenCalled();
  });
  it("preserves configured Codex, Claude and cloud models", () => {
    expect(perTurnModelRefusal(config, "codex", "base")).toBeNull();
    expect(perTurnModelRefusal(config, "claude", "other")).toBeNull();
    expect(perTurnModelRefusal(config, "cloud", "other")).toBeNull();
  });
});
