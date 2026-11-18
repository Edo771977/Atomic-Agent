import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AtomicAgentConfig } from "../../../config/index.js";
import { getConfig } from "../../../config/index.js";
import { parseFusionTeam, TEAM_MEMBER_PROVIDER_MODEL } from "../../../config/llm-fusion-team-config.js";
import { ProviderRegistry } from "./provider-registry.js";

/**
 * Issue #71: a Codex subscription (`subscription-cli`, cli `codex`) as a
 * fusion team reviewer. The desktop's Codex entry names no model (Codex
 * then uses the ChatGPT account's default), so its member is
 * `"<providerId>:default"`: the entry's own model. The reviewer's calls
 * then run on the entry itself, with no `-m`, never a copy asking Codex
 * for a model called "default".
 */
describe("a Codex subscription reviewer's model", () => {
  let stateDir: string | undefined;
  afterEach(() => {
    if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true });
    stateDir = undefined;
  });

  async function registry(defaultChatModel: string) {
    stateDir = mkdtempSync(join(tmpdir(), "codex-reviewer-"));
    const base = getConfig();
    const config = {
      ...base,
      paths: { ...base.paths, stateDir: stateDir! },
      llm: {
        activeTextProvider: "codex-cli",
        activeEmbeddingProvider: "local-llama-embed",
        toolTransport: "auto" as const,
        providers: [
          { id: "codex-cli", kind: "subscription-cli", subscriptionCli: { cli: "codex" }, defaultChatModel },
          { id: "api", kind: "openai-compatible", baseUrl: "https://api.example.invalid/v1", apiKey: "k", defaultChatModel: "model-a" },
        ],
      },
    } as AtomicAgentConfig;
    const ctx = {
      config,
      llamaClient: {} as never,
      getProfile: () => ({}) as never,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
    };
    return ProviderRegistry.fromConfig(config, ctx);
  }

  it("is a valid reviewer member", () => {
    expect(TEAM_MEMBER_PROVIDER_MODEL).toBe("default");
    const kindOf = (id: string) => ({ "codex-cli": "subscription-cli", api: "openai-compatible" })[id];
    expect(parseFusionTeam({ directors: ["codex-cli:default"], reviewers: ["codex-cli:default"] }, new Set(["codex-cli", "api"]), "team", kindOf))
      .toEqual({ directors: ["codex-cli:default"], reviewers: ["codex-cli:default"] });
  });

  it("is refused for an API provider: its prices and tiers are looked up by the model it names", () => {
    const kindOf = (id: string) => ({ "codex-cli": "subscription-cli", api: "openai-compatible" })[id];
    expect(() => parseFusionTeam({ directors: ["codex-cli:default"], reviewers: ["api:default"] }, new Set(["codex-cli", "api"]), "team", kindOf))
      .toThrow(/team\.reviewers\[0\].*"default" names the entry's own model only for a subscription-cli provider/);
  });

  it("asks an API provider for a model really called \"default\", on a copy", async () => {
    const reg = await registry("");
    const variant = await reg.modelVariant("api", TEAM_MEMBER_PROVIDER_MODEL);
    expect(variant).not.toBe(reg.getProvider("api"));
  });

  it("runs on the entry itself for \"default\", with the account's model", async () => {
    const reg = await registry("");
    const variant = await reg.modelVariant("codex-cli", TEAM_MEMBER_PROVIDER_MODEL);
    expect(variant).toBe(reg.getProvider("codex-cli"));
    expect(variant?.chatModelId).toBeUndefined();
  });

  it("asks Codex for a named model with a copy, as for any provider", async () => {
    const reg = await registry("");
    const variant = await reg.modelVariant("codex-cli", "model-r");
    expect(variant).not.toBe(reg.getProvider("codex-cli"));
    expect(variant?.chatModelId).toBe("model-r");
  });
});
