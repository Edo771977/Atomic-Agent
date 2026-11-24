import { parseToolCalls } from "../../grammar/tool-call-grammar.js";
import type { CompletionResult, OpenAiToolCall, StreamChunk } from "../completion-types.js";
import {
  createStreamUnmasker,
  isPrivacyShieldEnabledForRequest,
  privacyVaultFor,
  rebuildPrivacyVault,
  PrivacyArchiveLimitError,
  type PrivacyVault,
} from "../../../privacy/index.js";

/**
 * Privacy Shield on the OpenAI-compatible wire (ATO-1081). OpenAI-compatible cloud providers and the native Anthropic adapter use
 * this boundary before converting to their transport-specific format.
 *
 *  - Out: `maskOpenAiBody` swaps personal data and keys in the body's
 *    `messages` for the session's placeholders. Only `messages`: the
 *    tool schemas and sampling fields are ours, not the person's.
 *  - Back: `unmaskCompletion` and `createChunkUnmasker` put the values
 *    back in the reply text, the reasoning and the tool-call arguments,
 *    before the runtime shows, stores or runs any of it. Session history
 *    therefore keeps the real text, and the next request masks it again
 *    to the same placeholders.
 *
 * Auto mode skips local-looking addresses. An explicit on covers a gateway
 * there that forwards to the cloud. The llama-server text adapter reuses these helpers for raw and templated prompts.
 */

/** The vault for this request, or `null` when the shield does not apply. */
export function shieldVaultFor(
  sessionId: string | undefined,
  local: boolean,
  mode: "on" | "off" | "auto" | undefined,
): PrivacyVault | null {
  if (mode === "off" || (mode !== "on" && (local || !isPrivacyShieldEnabledForRequest(sessionId)))) return null;
  return privacyVaultFor(sessionId);
}

/**
 * Mask `body.messages` in place (the body is freshly built per send) and
 * count what this request masked (`vault.stats().lastRequest`).
 */
export function maskOpenAiBody(body: Record<string, unknown>, vault: PrivacyVault): void {
  const request = vault.beginRequest();
  try {
    if (body.messages !== undefined) body.messages = vault.maskDeep(body.messages, { jsonField: "arguments", request });
  } finally {
    vault.endRequest(request);
  }
}

export function maskWithArchiveRecovery(
  body: Record<string, unknown>,
  vault: PrivacyVault,
  sessionId: string | undefined,
): PrivacyVault {
  const couldRebuild = !vault.isEmpty;
  try {
    maskOpenAiBody(body, vault);
    return vault;
  } catch (error) {
    if (!couldRebuild || !(error instanceof PrivacyArchiveLimitError)) throw error;
    return rebuildPrivacyVault(sessionId, vault, fresh => maskOpenAiBody(body, fresh));
  }
}

const REFERENCE_INSTRUCTIONS =
  "Privacy Shield uses bracketed references for private values. Use these references exactly as written. The agent resolves them locally, so there is no need to ask for the original values.";

export function addPrivacyInstructions(body: Record<string, unknown>): void {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return;
  const first = body.messages[0] as { content?: unknown };
  if (typeof first.content === "string") {
    body.messages = [{ ...first, content: `${REFERENCE_INSTRUCTIONS}\n\n${first.content}` }, ...body.messages.slice(1)];
  } else if (Array.isArray(first.content)) {
    body.messages = [{ ...first, content: [{ type: "text", text: REFERENCE_INSTRUCTIONS }, ...first.content] }, ...body.messages.slice(1)];
  }
}

function unmaskToolCalls(
  calls: ReadonlyArray<OpenAiToolCall> | undefined,
  vault: PrivacyVault,
): ReadonlyArray<OpenAiToolCall> | undefined {
  if (!calls) return calls;
  let changed = false;
  const out = calls.map((call) => {
    // Arguments are JSON text: a restored value goes in escaped, so a
    // quote in a real value cannot break the call.
    const args = vault.unmask(call.function.arguments, { json: true });
    const name = vault.unmask(call.function.name);
    if (args === call.function.arguments && name === call.function.name) return call;
    changed = true;
    return { ...call, function: { ...call.function, name, arguments: args } };
  });
  return changed ? out : calls;
}

/**
 * Native providers can fall back to grammar-shaped tool calls in content.
 * Keep the payload parseable when a restored value contains JSON syntax.
 */
function unmaskReply(
  text: string,
  vault: PrivacyVault,
  jsonContent: boolean,
  mayContainGrammar: boolean,
): string {
  if (jsonContent) return vault.unmask(text, { json: true });
  const restored = vault.unmask(text);
  if (!mayContainGrammar || restored === text) return restored;
  try {
    parseToolCalls(text);
  } catch {
    return restored;
  }
  return vault.unmask(text, { json: true });
}

/** `result` with the session's placeholders put back everywhere the model writes. */
export function unmaskCompletion<T extends CompletionResult>(result: T, vault: PrivacyVault, jsonContent = false): T {
  if (vault.isEmpty) return result;
  const noNativeCalls = !result.toolCalls?.length;
  const content = unmaskReply(result.content, vault, jsonContent, noNativeCalls);
  const reasoningContent = unmaskReply(
    result.reasoningContent, vault, false, noNativeCalls && result.content.trim().length === 0,
  );
  const toolCalls = unmaskToolCalls(result.toolCalls, vault);
  if (
    content === result.content &&
    reasoningContent === result.reasoningContent &&
    toolCalls === result.toolCalls
  ) {
    return result;
  }
  return {
    ...result,
    content,
    reasoningContent,
    ...(toolCalls !== undefined ? { toolCalls } : {}),
  };
}

export interface ChunkUnmasker {
  /** The chunk with its text unmasked; a placeholder cut at its end is held back. */
  push(chunk: StreamChunk): StreamChunk;
  /** Whatever was held back at the end of the stream, or `null` for nothing. */
  flush(): StreamChunk | null;
}

/**
 * Unmasks streamed chunks. The reply and the reasoning are separate
 * streams, each with its own hold-back for a placeholder split between
 * two chunks (`[EMA` + `IL_1]`). One per stream attempt: a reopened
 * stream starts from scratch.
 */
export function createChunkUnmasker(vault: PrivacyVault, jsonContent = false): ChunkUnmasker {
  const text = createStreamUnmasker(vault, { json: jsonContent });
  const reasoning = createStreamUnmasker(vault);
  // A native-tool reply can carry a call array in content, with no wire
  // response format. Only its complete body can tell us how to escape it.
  let undecided: string | undefined = jsonContent ? undefined : "";
  let grammarCandidate = false;
  const pushText = (delta: string): string => {
    if (undecided === undefined) return text.push(delta);
    undecided += delta;
    if (grammarCandidate) return "";
    const start = undecided.trimStart();
    if (!start || /^\[\s*$/.test(start)) return "";
    if (start.startsWith("{") || /^\[\s*\{/.test(start)) {
      grammarCandidate = true;
      return "";
    }
    const buffered = undecided;
    undecided = undefined;
    return text.push(buffered);
  };
  return {
    push(chunk) {
      const delta = pushText(chunk.delta);
      const reasoningDelta = reasoning.push(chunk.reasoningDelta);
      if (delta === chunk.delta && reasoningDelta === chunk.reasoningDelta) return chunk;
      return { ...chunk, delta, reasoningDelta };
    },
    flush() {
      const delta = undecided === undefined ? text.flush() : unmaskReply(undecided, vault, false, true);
      undecided = undefined;
      const reasoningDelta = reasoning.flush();
      if (delta.length === 0 && reasoningDelta.length === 0) return null;
      return { delta, reasoningDelta, done: false };
    },
  };
}
