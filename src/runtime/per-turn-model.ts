import { isLocalServerUrl } from "../llm/provider/openai/local-server-url.js";
import { getCachedOpenAiCompatModelsForBaseUrl } from "../llm/provider/openai/fetch-openai-compat-models.js";
import { getCachedGeminiModelsForPanel } from "../llm/provider/gemini/fetch-gemini-models.js";
import type { LlmProviderConfigEntry, ResolvedLlmConfig } from "../llm/provider/registry/provider-types.js";
import { teamMembers } from "../llm/run-mode/fusion-team.js";
import { resolveModelPricingFor } from "./resolve-model-pricing.js";

/**
 * Why a per-turn model cannot run on `providerId`, or null when it can
 * (ATO-1148). Only a cloud entry takes one: a llama-server link, or an
 * OpenAI-compatible entry pointed at this machine (LM Studio, Ollama),
 * serves the one model the agent loaded for everyone. And only a model
 * known for that entry ({@link perTurnModelIsKnown}): an arbitrary
 * string would build a provider copy per string and run at no known price.
 */
export function perTurnModelRefusal(
  resolved: ResolvedLlmConfig,
  providerId: string,
  model: string,
): string | null {
  if (model.trim().length === 0 || /[\r\n\x00]/.test(model)) {
    return "a per-turn model must be a model id";
  }
  const entry = resolved.providers.find((p) => p.id === providerId);
  if (entry === undefined) return `cannot pin turn to llm provider "${providerId}": not configured`;
  if (entry.kind === "llama-server" || isLocalServerUrl(entry.baseUrl ?? entry.url)) {
    return `"${providerId}" is a local model, which is shared by all projects; a per-turn model works on cloud providers only`;
  }
  if (!perTurnModelIsKnown(resolved, entry, model)) {
    return `model "${model}" is not known for llm provider "${providerId}": add it to the provider's userModels, or pick one its model list shows`;
  }
  return null;
}

/**
 * Whether `model` is one `entry` is known to serve: the entry's own chat
 * model, a `userModels` row, a row of its bundled catalog, the official
 * price table or the models.dev snapshot for its preset (whatever
 * `resolveModelPricingFor` resolves from a source other than the
 * nominal default), or an id in the entry's cached model list
 * (`/v1/models`, Gemini's list) fetched by a model picker. A model the
 * fusion team (`llm.runMode.fusion.team`, issue #37) lists for this
 * provider counts too: the person named it for that entry, which is how a
 * subscription CLI without a model list (Codex) gets one.
 */
export function perTurnModelIsKnown(
  resolved: ResolvedLlmConfig,
  entry: LlmProviderConfigEntry,
  model: string,
): boolean {
  if (model === (entry.defaultChatModel ?? entry.model)) return true;
  if (entry.userModels?.some((row) => row.id === model)) return true;
  if (isTeamModel(resolved, entry.id, model)) return true;
  const row = resolveModelPricingFor(resolved, model, entry.id);
  if (row !== undefined && (row.source !== "default" || row.pricingSource !== undefined)) return true;
  const baseUrl = entry.baseUrl ?? entry.url;
  const listed = entry.kind === "gemini"
    ? getCachedGeminiModelsForPanel()
    : baseUrl === undefined ? undefined : getCachedOpenAiCompatModelsForBaseUrl(baseUrl);
  return listed?.includes(model) === true;
}

function isTeamModel(resolved: ResolvedLlmConfig, providerId: string, model: string): boolean {
  const team = resolved.runMode?.fusion?.team;
  return (["directors", "workers", "reviewers"] as const).some((role) =>
    teamMembers(team, role).some((m) => m.providerId === providerId && m.model === model),
  );
}
