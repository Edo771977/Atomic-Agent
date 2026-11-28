import type { CompletionRequestBudget } from "../completion-types.js";
import { openAiFetch, type OpenAiHttpDeps } from "../openai/openai-http.js";
import { maskOpenAiBody, shieldVaultFor } from "../openai/openai-privacy-shield.js";
import { isLocalServerUrl } from "../openai/local-server-url.js";
import { withFreshPrivacyVault } from "../../../privacy/index.js";

/** Setup probes use synthetic prompts, but retain the caller's admission and budget on every send. */
export interface AuxiliaryProbeAdmission {
  beforeSend?: () => void;
  requestBudget?: CompletionRequestBudget;
}

export function auxiliaryProbeFetch(
  deps: OpenAiHttpDeps,
  path: string,
  body: Record<string, unknown> | null,
  request: AuxiliaryProbeAdmission & { signal?: AbortSignal },
  stream: boolean,
  method: "GET" | "POST",
): Promise<Response> {
  return withFreshPrivacyVault(() => {
    const vault = shieldVaultFor(undefined, isLocalServerUrl(deps.baseUrl), undefined);
    const outgoing = body === null ? null : structuredClone(body);
    if (vault && outgoing) maskOpenAiBody(outgoing, vault);
    return openAiFetch(deps, path, outgoing, request, stream, method);
  });
}
