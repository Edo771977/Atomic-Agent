import type { LlmProvider } from "../../llm/index.js";
import { resolveCloudModelVision } from "../../llm/provider/model-vision.js";
import type { LlmProviderConfigEntry } from "../../llm/provider/registry/provider-types.js";
import type { ProviderRegistry } from "../../llm/provider/registry/provider-registry.js";
import type { TeamMember } from "../../llm/run-mode/fusion-team.js";
import type { FusionDelegateDeps } from "../../tools/fusion/fusion-delegate.js";
import { loadImageFile } from "../../tools/vision/load-image.js";
import { providerOffersVision } from "../vision-route.js";

/** Screenshots are JPEGs of at most 900 KB; anything bigger is not one of ours. */
const MAX_SHOT_BYTES = 2 * 1024 * 1024;

/**
 * The fusion vision judge's seam to the providers (issue #40): whether a
 * team member sees, the member `vision.describe` routes to, and one
 * describe call on the member's own model. A cloud member's vision is
 * the verdict for its model (`resolveCloudModelVision`); a local server
 * sees when its provider offers vision (`providerOffersVision`). The
 * call is refused by the folder's provider policy (`assertAllowed`)
 * before any screenshot is read, and goes to the registry's guarded
 * provider (or its guarded model copy), as escalation does.
 */
export function buildFusionVisionJudge(input: {
  providerRegistry: Pick<ProviderRegistry, "getProvider"> & Partial<Pick<ProviderRegistry, "modelVariant">>;
  providerEntries: () => readonly LlmProviderConfigEntry[];
  /** The provider `vision.describe` would use now (the live route). */
  routeProvider: () => LlmProvider | undefined;
  assertAllowed: (providerId: string) => void;
}): NonNullable<FusionDelegateDeps["visionJudge"]> {
  const entryOf = (id: string) => input.providerEntries().find((e) => e.id === id);
  const isLocal = (entry: LlmProviderConfigEntry | undefined): boolean => entry === undefined || entry.kind === "llama-server";
  return {
    sees: (member: TeamMember) => {
      const entry = entryOf(member.providerId);
      const provider = input.providerRegistry.getProvider(member.providerId);
      if (provider === undefined) return false;
      if (isLocal(entry)) return providerOffersVision(provider, true);
      return resolveCloudModelVision(entry!, member.model).vision;
    },
    route: () => {
      const provider = input.routeProvider();
      if (provider === undefined) return null;
      const entry = entryOf(provider.id);
      const model = provider.chatModelId ?? entry?.defaultChatModel ?? entry?.model ?? provider.id;
      return { providerId: provider.id, model, ref: `${provider.id}:${model}` };
    },
    describe: async (call) => {
      input.assertAllowed(call.providerId);
      const base = input.providerRegistry.getProvider(call.providerId);
      if (base === undefined) throw new Error(`vision provider ${call.providerId} is not configured`);
      const provider = call.model === undefined || base.chatModelId === call.model
        ? base
        : (await input.providerRegistry.modelVariant?.(call.providerId, call.model)) ?? base;
      input.assertAllowed(provider.id ?? call.providerId);
      const images = [];
      for (const [i, path] of call.imagePaths.entries()) {
        const loaded = await loadImageFile(path, "/", { maxBytes: MAX_SHOT_BYTES });
        images.push({ id: i, bytes: loaded.bytes, mimeType: loaded.mimeType });
      }
      const result = await provider.describeImage({
        prompt: call.prompt,
        images,
        maxTokens: call.maxTokens,
        temperature: 0,
        signal: call.signal,
        ...(call.model === undefined ? {} : { model: call.model }),
      });
      const model = call.model ?? provider.chatModelId ?? entryOf(call.providerId)?.defaultChatModel ?? entryOf(call.providerId)?.model;
      return {
        text: result.text,
        ...(model === undefined ? {} : { modelRef: `${call.providerId}:${model}` }),
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      };
    },
  };
}
