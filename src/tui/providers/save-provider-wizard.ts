import { getConfig } from "../../config/index.js";
import type { UserLlmProviderEntry } from "../../config/llm-config.js";
import {
  blockedNativeKeyVariable,
  maySendSharedOpenAiKey,
  resolveLlmProviderApiKey,
} from "../../config/resolve-llm-api-key.js";
import { isAsciiOnly } from "../../llm/provider/openai/ascii-header-guard.js";
import {
  setActiveTextProviderInConfig,
  upsertLlmProvider,
  writeProviderApiKeyToDotenv,
} from "../../config/llm-provider-commands.js";
import { findProviderPreset } from "./provider-presets.js";
import {
  isSharedCompatKeyVar,
  networkComputerKeyEnvVar,
  ownPresetKeyEnvVar,
  wizardKeyIsOptional,
} from "./providers-wizard-target.js";
import {
  storedEntryAtBaseUrl,
  storedProviderFileEntry,
} from "./stored-provider-entry.js";
import {
  AIMLAPI_DEFAULT_CHAT_MODEL,
  GEMINI_DEFAULT_CHAT_MODEL,
  LOCAL_EMBEDDING_CHOICE_ID,
  OPENROUTER_DEFAULT_CHAT_MODEL,
} from "./providers-model-options.js";
import {
  buildProviderEntryFromWizard,
  type BuiltWizardProvider,
} from "./providers-wizard-build-entry.js";
import {
  subscriptionCliForWizardKind,
  type ProvidersWizardKind,
  type ProvidersWizardState,
} from "./providers-wizard-state.js";
import {
  registerBuiltInCliAdapters,
  resolveCliAdapter,
} from "../../llm/provider/subscription-cli/index.js";

function defaultChatModelForKind(kind: ProvidersWizardKind): string {
  const cli = subscriptionCliForWizardKind(kind);
  if (cli) {
    registerBuiltInCliAdapters();
    return resolveCliAdapter(cli).defaultChatModel;
  }
  if (kind === "aimlapi") return AIMLAPI_DEFAULT_CHAT_MODEL;
  if (kind === "gemini") return GEMINI_DEFAULT_CHAT_MODEL;
  return OPENROUTER_DEFAULT_CHAT_MODEL;
}

export { networkComputerKeyEnvVar };

/**
 * `entry` with the stored entry's hand-set request shaping kept: extra
 * headers (merged over the preset's, the operator's value winning), the
 * key header, extra body fields and the user model list with its
 * pricing. `upsertLlmProvider` replaces the whole entry, so a field left
 * off here is deleted from config.json.
 */
function withStoredRequestShaping(
  entry: UserLlmProviderEntry,
  stored: UserLlmProviderEntry,
): UserLlmProviderEntry {
  let next = entry;
  if (stored.headers) next = { ...next, headers: { ...next.headers, ...stored.headers } };
  if (stored.apiKeyHeader !== undefined && next.apiKeyHeader === undefined) {
    next = { ...next, apiKeyHeader: stored.apiKeyHeader };
  }
  if (stored.extraBody !== undefined && next.extraBody === undefined) {
    next = { ...next, extraBody: stored.extraBody };
  }
  if (stored.userModels !== undefined && next.userModels === undefined) {
    next = { ...next, userModels: stored.userModels };
  }
  return next;
}

export function saveProviderWizardToConfig(
  wizard: ProvidersWizardState,
): BuiltWizardProvider {
  const kind = wizard.kind;
  if (!kind) {
    throw new Error("wizard kind is missing");
  }

  const providers = getConfig().llm?.providers ?? [];
  // The entry as written in config.json (`storedProviderFileEntry`).
  const storedFile =
    wizard.mode === "configure" && wizard.providerId
      ? storedProviderFileEntry(wizard.providerId)
      : undefined;
  const built = buildProviderEntryFromWizard({
    kind,
    presetId: wizard.presetId,
    existingProviderId: wizard.mode === "configure" ? wizard.providerId : null,
    takenProviderIds: providers.map((provider) => provider.id),
    chatModelId: wizard.selectedChatModelId ?? defaultChatModelForKind(kind),
    embeddingChoiceId:
      wizard.selectedEmbeddingChoiceId ?? LOCAL_EMBEDDING_CHOICE_ID,
    baseUrl: wizard.baseUrlLine,
    customChatModel: wizard.chatModelLine,
    customEmbeddingModel: wizard.embeddingModelLine,
    ...(storedFile ? { storedKind: storedFile.kind } : {}),
  });

  const existing = providers.find((provider) => provider.id === built.entry.id);
  let entry = built.entry;
  // Reconfiguring must not wipe what the wizard has no screen for: a
  // subscription-cli entry can carry a hand-set binPath / extraArgs /
  // streaming flag / spend ceiling, and any entry a request timeout.
  // `upsertLlmProvider` preserves model policy but replaces other fields,
  // so carry them over; the key is handled below, from config.json itself.
  if (existing?.subscriptionCli && entry.subscriptionCli) {
    entry = {
      ...entry,
      subscriptionCli: {
        ...existing.subscriptionCli,
        cli: entry.subscriptionCli.cli,
      },
    };
  }
  if (
    existing?.requestTimeoutMs !== undefined &&
    entry.requestTimeoutMs === undefined
  ) {
    entry = { ...entry, requestTimeoutMs: existing.requestTimeoutMs };
  }
  const preset = wizard.presetId
    ? findProviderPreset(wizard.presetId)
    : undefined;
  // Local servers (including a hand-added loopback endpoint) have no key
  // at all, and keyless-listing services work before one is entered, so
  // an empty key is a valid state for both: nothing is written to .env
  // and requests go out without Authorization.
  const keyOptional = wizardKeyIsOptional(wizard);
  // ATO-1066: an endpoint the shared compat variables are never sent to
  // (a server on another computer on this network, or plain http:// to a
  // host that is not this machine) cannot use a key saved there: the
  // resolver refuses it, and saving it would overwrite the operator's
  // cloud key. A key typed for it lives under a variable of its own: the
  // entry's stored variable, unless that is a shared OPENAI_* name (an
  // entry moved from the cloud), whose cloud key it would overwrite.
  // The entry as written in config.json, moved to its new address. Never
  // `existing` for keys: getConfig() has already filled its apiKey from
  // the environment, and copying that wrote a shared cloud key into
  // config.json in clear (ATO-1066).
  const stored = storedFile
    ? storedEntryAtBaseUrl(storedFile, entry.baseUrl)
    : undefined;
  const networkKeyEnvVar =
    !preset &&
    entry.kind === "openai-compatible" &&
    !maySendSharedOpenAiKey(entry.baseUrl)
      ? (stored?.apiKeyEnvVar !== undefined && !isSharedCompatKeyVar(stored.apiKeyEnvVar)
          ? stored.apiKeyEnvVar
          : networkComputerKeyEnvVar(entry.id))
      : undefined;
  // A preset entry on a variable of its own keeps it (`ownPresetKeyEnvVar`):
  // the preset's is the operator's other account's key.
  const ownKeyEnvVar = preset ? ownPresetKeyEnvVar(preset, stored) : undefined;
  if (ownKeyEnvVar) entry = { ...entry, apiKeyEnvVar: ownKeyEnvVar };
  // Request shaping the wizard has no screen for, read from config.json
  // (not `existing`, whose values the environment may have filled).
  if (storedFile) entry = withStoredRequestShaping(entry, storedFile);
  if (wizard.apiKeyBuffer.trim().length > 0) {
    const configuredEnv = entry.apiKeyEnvVar ?? stored?.apiKeyEnvVar;
    const gatewayEnv = blockedNativeKeyVariable({ ...entry, apiKeyEnvVar: configuredEnv })
      ? networkComputerKeyEnvVar(entry.id)
      : networkKeyEnvVar;
    // Validate the value that is actually persisted: the dotenv writer
    // trims, and `trim()` strips U+00A0/U+FEFF paste artifacts that are
    // non-ASCII themselves. Checking the raw buffer here would refuse a
    // key whose stored form is pure ASCII — after the key screen (which
    // trims) already accepted it.
    if (!isAsciiOnly(wizard.apiKeyBuffer.trim())) {
      // A non-ASCII key cannot go into an Authorization header and would
      // otherwise crash the first request with an opaque ByteString error.
      throw new Error(
        "API key contains non-ASCII characters. Use a plain ASCII key.",
      );
    }
    writeProviderApiKeyToDotenv(
      kind,
      wizard.apiKeyBuffer,
      gatewayEnv ?? ownKeyEnvVar ?? preset?.envVar,
    );
    if (gatewayEnv) entry = { ...entry, apiKeyEnvVar: gatewayEnv };
  } else if (stored?.apiKey) {
    entry = { ...entry, apiKey: stored.apiKey };
  } else if (
    stored?.apiKeyEnvVar &&
    !entry.apiKeyEnvVar &&
    // A shared OPENAI_* name moved to an endpoint the shared key may not
    // reach: carried over, the resolver would honour it as an explicit
    // choice and send the cloud key there (in clear for http://).
    !(networkKeyEnvVar !== undefined && isSharedCompatKeyVar(stored.apiKeyEnvVar))
  ) {
    // Still a variable: the key stays in .env, under the name the
    // operator gave it.
    entry = { ...entry, apiKeyEnvVar: stored.apiKeyEnvVar };
  } else if (
    !keyOptional &&
    !resolveLlmProviderApiKey(entry) &&
    !(stored && resolveLlmProviderApiKey(stored))
  ) {
    throw new Error("API key is empty — paste a key or set it in .env first");
  }

  entry = upsertLlmProvider(entry, {
    activateEmbeddingProviderId: built.activateEmbeddingProviderId,
  });
  setActiveTextProviderInConfig(entry.id);

  return { ...built, entry };
}
