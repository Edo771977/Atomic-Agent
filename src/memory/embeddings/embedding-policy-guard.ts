import { hostOfUrl, isLoopbackHost } from "../../llm/offline-network.js";
import {
  currentProviderPolicyFrame,
  networkEndpointListed,
  ProviderNotAllowedError,
} from "../../llm/provider-policy.js";
import { EmbeddingUnavailableError, type EmbeddingClient } from "./embedding-client.js";

/**
 * Whether the memory embedding endpoint is this machine: Atomic Core's
 * embedding module (`viaCore`, reached on loopback), or a URL whose host
 * is loopback. The LAN counts as network, as for offline mode.
 */
export function embeddingEndpointOnMachine(url: string, viaCore: boolean): boolean {
  if (viaCore) return true;
  const host = hostOfUrl(url);
  return host !== null && isLoopbackHost(host);
}

/**
 * Per-folder provider constraints for memory embeddings (issue #33).
 * Embeddings carry session content (notes, queries) but are not a
 * configured provider id, so the rule is by place: an endpoint on this
 * machine is always allowed; any other is refused in a constrained
 * folder, and with no policy frame while any constraint exists (fail
 * closed). The refusal is an `EmbeddingUnavailableError`, so recall and
 * the writer take their documented FTS-only fallback; nothing is sent.
 * One exception (issue #60): an endpoint on a computer of the local
 * network that the folder lists in `allowedProviderHosts` (`url`). A
 * public endpoint stays refused even when listed, since embeddings have
 * no provider id for the id-only match.
 */
export function guardEmbeddingClient(
  client: EmbeddingClient,
  options: { onMachine: boolean; constraintsActive: () => boolean; url?: string },
): EmbeddingClient {
  if (options.onMachine) return client;
  return {
    get dim() { return client.dim; },
    get model() { return client.model; },
    async embed(req) {
      const frame = currentProviderPolicyFrame();
      const refusal = frame === undefined
        ? options.constraintsActive()
          ? new ProviderNotAllowedError({ reason: "no-policy", providerId: "memory embeddings", role: "memory embeddings" })
          : undefined
        : frame.policy === undefined || networkEndpointListed(frame.policy, options.url)
          ? undefined
          : new ProviderNotAllowedError({ reason: "not-allowed", providerId: "memory embeddings (off this machine)", policy: frame.policy, role: "memory embeddings" });
      if (refusal !== undefined) throw new EmbeddingUnavailableError(refusal.message, refusal);
      return client.embed(req);
    },
  };
}
