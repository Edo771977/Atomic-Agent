import type { StreamConsumer } from "../adapters/stream-consumer.js";
import type { ReasoningFormat } from "../llm-provider.js";
import { createOpenAiStreamConsumer } from "../openai/openai-stream-consumer.js";
import { createAnthropicSseTranslator } from "./anthropic-messages-response.js";

/**
 * The OpenAI stream consumer, fed an Anthropic SSE body rewritten into
 * OpenAI chunks (`createAnthropicSseTranslator`). Everything the shared
 * consumer guards — tool-call assembly, the terminal signal (`[DONE]`
 * from `message_stop`), mid-stream errors, the fabricated-transcript
 * watcher, cancellation — applies unchanged.
 *
 * Transport release: the provider cancels the response body when a pump
 * walks away, but this wrapper holds the body's reader, so the cancel is
 * done here, on the way out of the generator, whenever the source did not
 * end on its own. The provider's later cancel is then a no-op.
 */
export function createAnthropicStreamConsumer(
  reasoningFormat: ReasoningFormat = "auto",
): StreamConsumer {
  const inner = createOpenAiStreamConsumer(reasoningFormat);
  return {
    async *consume(body, signal) {
      if (!body) return;
      const reader = body.getReader();
      const decoder = new TextDecoder();
      const translator = createAnthropicSseTranslator();
      const encoder = new TextEncoder();
      let sourceDone = false;
      const translated = new ReadableStream<Uint8Array>({
        async pull(controller) {
          for (;;) {
            let next: Awaited<ReturnType<typeof reader.read>>;
            try {
              next = await reader.read();
            } catch (err) {
              sourceDone = true;
              controller.error(err);
              return;
            }
            if (next.done) {
              sourceDone = true;
              const tail = translator.push(decoder.decode()) + translator.flush();
              if (tail.length > 0) controller.enqueue(encoder.encode(tail));
              controller.close();
              return;
            }
            const out = translator.push(decoder.decode(next.value, { stream: true }));
            if (out.length > 0) {
              controller.enqueue(encoder.encode(out));
              return;
            }
          }
        },
        cancel(reason) {
          sourceDone = true;
          return reader.cancel(reason).catch(() => undefined);
        },
      });
      try {
        return yield* inner.consume(translated, signal);
      } finally {
        // Not awaited: a cancel travelling into a socket must never hang the unwind.
        if (!sourceDone) void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
  };
}
