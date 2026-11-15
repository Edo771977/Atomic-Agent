import { join, resolve } from "node:path";

import {
  getUserConfigPath,
  loadDotenvFromStateDir,
  readUserConfigSnapshotSync,
  type UserConfigFile,
} from "../config/index.js";
import { readSetAsideEnumValueOnDiskSync } from "../config/config-file.js";
import { SUBSCRIPTION_CLIS, type SubscriptionCliName } from "../config/llm-config.js";
import {
  dotenvKeyForProviderKind,
  readLlmBlockOrDefault,
} from "../config/llm-provider-commands.js";
import { providerKeyStatus } from "../llm/provider/provider-key.js";
import { fetchOpenAiCompatModels } from "../llm/provider/openai/fetch-openai-compat-models.js";
import { PROVIDER_PRESETS, type ProviderPreset } from "../llm/provider/presets/provider-presets.js";
import {
  checkSubscriptionCli,
  configuredSubscriptionBinPath,
  registerBuiltInCliAdapters,
  resolveCliAdapter,
  type SubscriptionCliStatusReport,
} from "../llm/provider/subscription-cli/index.js";
import type {
  FusionSetupEnvKeyFact,
  FusionSetupFacts,
  FusionSetupProviderFact,
} from "../llm/run-mode/fusion-setup-plan.js";
import { recommendModelTiers } from "../local-llm/catalog/model-upgrade.js";
import { probeMachineForModels } from "../local-llm/backend/machine-for-models.js";
import {
  isModelDownloaded,
  listLocalModels,
  setCustomLocalModels,
} from "../local-llm/index.js";

/**
 * Gather what `setup fusion` plans from, without writing anything: the
 * config is read (not created), `.env` is loaded so a key there counts,
 * and the CLI check never runs a turn. Every probe is injectable.
 */
export interface FusionDetectDeps {
  readonly checkCli?: (
    cli: SubscriptionCliName,
    binPath: string | undefined,
  ) => Promise<Pick<SubscriptionCliStatusReport, "state" | "fix">>;
  /** Ids of catalog chat models on disk under `dataDir`. */
  readonly downloadedModelIds?: (dataDir: string) => string[];
  /** The catalog's pick for this machine (null when none fits). */
  readonly recommendModelId?: (dataDir: string, file: UserConfigFile) => Promise<string | null>;
  readonly claudeCliDefaultModel?: () => string | null;
  /** External mode: does a llama-server answer `/health` at `url`? */
  readonly probeExternal?: (url: string) => Promise<boolean>;
  /** Load `<stateDir>/.env` into the environment (default: yes). */
  readonly loadDotenv?: (stateDir: string) => void;
  /** Where preset key variables are looked up, after `.env` is loaded (default: `process.env`). */
  readonly env?: () => NodeJS.ProcessEnv;
  /**
   * Model ids a preset's `/v1/models` lists with this key, or null when
   * it cannot be asked. Only called (by `fillEnvKeyPresetModels`) for a
   * preset with a key set, no entry and no default model of its own, and
   * only when setup could choose it; the ids are narrowed to chat models.
   */
  readonly listPresetModels?: (preset: ProviderPreset, apiKey: string) => Promise<readonly string[] | null>;
}

function defaultDownloadedIds(dataDir: string): string[] {
  return listLocalModels()
    .filter((def) => isModelDownloaded(dataDir, def))
    .map((def) => def.id);
}

async function defaultRecommend(dataDir: string, file: UserConfigFile): Promise<string | null> {
  const machine = await probeMachineForModels({
    dataDir,
    engine: file.localModels.managed.engine,
    configuredDevice: file.localModels.managed.device,
  });
  const tiers = recommendModelTiers(machine);
  return (tiers.balanced ?? tiers.quality ?? tiers.fast)?.id ?? null;
}

async function defaultProbeExternal(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function defaultListPresetModels(preset: ProviderPreset, apiKey: string): Promise<readonly string[] | null> {
  try {
    return await fetchOpenAiCompatModels(preset.baseUrl, apiKey, preset);
  } catch {
    return null;
  }
}

/**
 * Model ids `/v1/models` lists that are not chat models: embeddings,
 * speech in or out, moderation, image generation, rerankers. Matched on
 * the naming the major endpoints use; anything else is kept.
 */
const NON_CHAT_MODEL =
  /embed|(?:^|[-_/.])tts(?:$|[-_/.])|whisper|transcri|speech|moderation|dall-e|gpt-image|stable-diffusion|rerank/i;

/** The chat models among the ids an endpoint lists. */
export function chatModelIds(ids: readonly string[]): string[] {
  return ids.filter((id) => !NON_CHAT_MODEL.test(id));
}

/**
 * Cloud presets whose key variable is set while no entry reads it (the
 * key in `.env` the setup would otherwise ignore). The facts carry the
 * variable's name, never its value. Their `models` start null: asking
 * the endpoint costs a request with the key, so `fillEnvKeyPresetModels`
 * does it only once setup could choose that preset.
 */
function detectEnvKeyPresets(
  providers: readonly FusionSetupProviderFact[],
  deps: FusionDetectDeps,
): FusionSetupEnvKeyFact[] {
  const env = (deps.env ?? (() => process.env))();
  const read = new Set(providers.map((p) => p.envVar).filter((v): v is string => v !== null));
  const ids = new Set(providers.map((p) => p.id));
  return PROVIDER_PRESETS.filter((preset) => {
    if (preset.local || preset.perAccountEndpoint) return false;
    if (read.has(preset.envVar) || ids.has(preset.id)) return false;
    return (env[preset.envVar] ?? "").trim() !== "";
  }).map((preset) => ({ presetId: preset.id, envVar: preset.envVar, models: null }));
}

/**
 * Ask each named key-only preset's own endpoint which chat models it
 * serves (with the key, never echoed), for a preset with no default
 * model of its own whose list was not asked yet. Returns new facts.
 */
export async function fillEnvKeyPresetModels(
  facts: FusionSetupFacts,
  presetIds: readonly string[],
  deps: FusionDetectDeps = {},
): Promise<FusionSetupFacts> {
  const presets = facts.envKeyPresets;
  if (presets === undefined) return facts;
  const env = (deps.env ?? (() => process.env))();
  const list = deps.listPresetModels ?? defaultListPresetModels;
  const envKeyPresets = await Promise.all(
    presets.map(async (fact) => {
      if (fact.models !== null || !presetIds.includes(fact.presetId)) return fact;
      const preset = PROVIDER_PRESETS.find((p) => p.id === fact.presetId);
      const own = (preset as { readonly defaultChatModel?: unknown } | undefined)?.defaultChatModel;
      if (!preset || (typeof own === "string" && own !== "")) return fact;
      const models = await list(preset, (env[preset.envVar] ?? "").trim());
      return { ...fact, models: models ? chatModelIds(models) : null };
    }),
  );
  return { ...facts, envKeyPresets };
}

function defaultCheckCli(cli: SubscriptionCliName, binPath: string | undefined) {
  registerBuiltInCliAdapters();
  return checkSubscriptionCli(resolveCliAdapter(cli), binPath ? { binPath } : {});
}

function defaultClaudeModel(): string | null {
  registerBuiltInCliAdapters();
  return resolveCliAdapter("claude").defaultChatModel || null;
}

/** The enum settings the preset fills or mentions; a newer build's value there is kept. */
const SET_ASIDE_FUSION_KEYS = [
  "llm.runMode.fusion.escalation",
  "llm.runMode.fusion.judge",
  "llm.runMode.fusion.isolation",
] as const;

const CREDENTIAL_KINDS = new Set(["openrouter", "aimlapi", "gemini", "openai-compatible"]);

export async function detectFusionSetup(
  stateDir: string,
  deps: FusionDetectDeps = {},
): Promise<FusionSetupFacts> {
  (deps.loadDotenv ?? ((dir) => { loadDotenvFromStateDir(dir); }))(stateDir);
  // The snapshot read names the file in a validation error (a missing
  // file reads as the defaults); the caller prints it and stops.
  const configPath = getUserConfigPath(stateDir);
  const file = readUserConfigSnapshotSync(configPath).config;
  setCustomLocalModels(file.localModels.customModels);
  const llm = readLlmBlockOrDefault(file);

  const providers: FusionSetupProviderFact[] = llm.providers.map((p) => ({
    id: p.id,
    kind: p.kind,
    keyState: providerKeyStatus(p).state,
    envVar:
      p.apiKeyEnvVar ||
      (CREDENTIAL_KINDS.has(p.kind)
        ? dotenvKeyForProviderKind(p.kind as Parameters<typeof dotenvKeyForProviderKind>[0])
        : null),
    subscriptionCli: p.subscriptionCli?.cli ?? null,
    defaultChatModel: p.defaultChatModel ?? null,
  }));

  const envKeyPresets = detectEnvKeyPresets(providers, deps);

  const wanted = new Set<SubscriptionCliName>(["claude"]);
  for (const p of providers) {
    if ((SUBSCRIPTION_CLIS as readonly string[]).includes(p.subscriptionCli ?? "")) {
      wanted.add(p.subscriptionCli as SubscriptionCliName);
    }
  }
  const checkCli = deps.checkCli ?? defaultCheckCli;
  const subscriptionClis: Record<string, { state: SubscriptionCliStatusReport["state"]; fix: string | null }> = {};
  await Promise.all(
    [...wanted].map(async (cli) => {
      const r = await checkCli(cli, configuredSubscriptionBinPath(llm.providers, cli));
      subscriptionClis[cli] = { state: r.state, fix: r.fix };
    }),
  );

  const managed = file.localModels.managed;
  const dataDir = managed.dataDirOverride
    ? resolve(managed.dataDirOverride)
    : join(stateDir, "models");
  const mode = file.localModels.mode === "managed" ? "managed" : "external";
  const url = mode === "managed" ? `http://127.0.0.1:${managed.port}` : file.localModels.url;
  const externalAnswers =
    mode === "external" ? await (deps.probeExternal ?? defaultProbeExternal)(url) : null;
  // Models on disk count in either mode: on an external server that does
  // not answer, they are what `models use` can switch to.
  const downloadedModelIds = (deps.downloadedModelIds ?? defaultDownloadedIds)(dataDir);
  const managedModelOnDisk =
    managed.modelId !== null && downloadedModelIds.includes(managed.modelId);
  const recommendedModelId =
    downloadedModelIds.length === 0 && externalAnswers !== true
      ? await (deps.recommendModelId ?? defaultRecommend)(dataDir, file)
      : null;

  const setAside: Record<string, string> = {};
  for (const key of SET_ASIDE_FUSION_KEYS) {
    const value = readSetAsideEnumValueOnDiskSync(configPath, key);
    if (value !== undefined) setAside[key] = value;
  }

  return {
    stateDir,
    activeTextProvider: llm.activeTextProvider,
    providers,
    runMode: llm.runMode,
    subscriptionClis,
    claudeCliDefaultModel: (deps.claudeCliDefaultModel ?? defaultClaudeModel)(),
    local: {
      mode,
      url,
      externalAnswers,
      managedModelId: managed.modelId,
      managedModelOnDisk,
      downloadedModelIds,
      recommendedModelId,
    },
    setAside,
    ...(envKeyPresets.length > 0 ? { envKeyPresets } : {}),
  };
}
