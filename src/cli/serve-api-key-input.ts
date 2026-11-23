import { closeSync, fstatSync, openSync, type Stats } from "node:fs";
import { devNull } from "node:os";
import type { Readable } from "node:stream";

/** ATO-1126: the shortest explicit API key serve takes. */
export const MIN_EXPLICIT_KEY_LENGTH = 16;
const MAX_STDIN_LINE_BYTES = 4096;
const STDIN_TIMEOUT_MS = 10_000;

type KeyInput = { key: string } | { error: string };

export function validateExplicitKey(raw: string, source: "--api-key-file" | "--api-key-stdin"): KeyInput {
  const key = raw.trim();
  if (!/^[!-~]+$/.test(key)) {
    return { error: source + " expects one key with printable ASCII characters and no spaces" };
  }
  if (key.length < MIN_EXPLICIT_KEY_LENGTH) {
    return { error: source + " requires a key with at least " + MIN_EXPLICIT_KEY_LENGTH + " characters" };
  }
  return { key };
}

function stdinIdentity(): Stats | undefined {
  try {
    return fstatSync(0);
  } catch {
    return undefined;
  }
}

/** Release the credential stream and reserve fd 0 so sockets cannot reuse it. */
function releaseStdinDescriptor(original: Stats | undefined): string | undefined {
  try {
    const current = stdinIdentity();
    if (current !== undefined) {
      if (original === undefined || current.dev !== original.dev ||
        current.ino !== original.ino || current.mode !== original.mode) {
        return "--api-key-stdin descriptor 0 changed while reading the key";
      }
      closeSync(0);
    }
    const fd = openSync(devNull, "r");
    if (fd !== 0) {
      closeSync(fd);
      return "--api-key-stdin could not reserve descriptor 0";
    }
  } catch {
    return "--api-key-stdin could not replace stdin with the null device";
  }
  return undefined;
}

/** Consume one bounded, newline-terminated credential and release the input. */
export function readServeKeyFromStdin(
  stream?: Readable,
  timeoutMs = STDIN_TIMEOUT_MS,
): Promise<KeyInput> {
  const input = stream ?? process.stdin;
  const original = stream === undefined ? stdinIdentity() : undefined;
  return new Promise(resolve => {
    const parts: Buffer[] = [];
    let length = 0;
    const timer = setTimeout(() => finish({ error: "--api-key-stdin timed out waiting for a key line" }), timeoutMs);

    function finish(result: KeyInput): void {
      clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.off("error", onError);
      const complete = () => {
        const error = stream === undefined ? releaseStdinDescriptor(original) : undefined;
        resolve(error === undefined ? result : { error });
      };
      if (input.closed) {
        complete();
        return;
      }
      input.once("close", complete);
      input.destroy();
    }

    function onEnd(): void {
      finish({ error: length === 0 ? "--api-key-stdin received no API key line" :
        "--api-key-stdin expects an API key followed by a newline" });
    }

    function onError(): void {
      finish({ error: "--api-key-stdin could not read the API key line" });
    }

    function onData(value: Buffer | string): void {
      const chunk = typeof value === "string" ? Buffer.from(value) : value;
      const newline = chunk.indexOf(0x0a);
      const part = newline < 0 ? chunk : chunk.subarray(0, newline);
      length += part.length;
      if (length > MAX_STDIN_LINE_BYTES) {
        finish({ error: "--api-key-stdin line exceeds 4096 bytes" });
        return;
      }
      parts.push(part);
      if (newline < 0) return;
      const line = Buffer.concat(parts, length).toString("utf8");
      finish(line.trim().length === 0 ? { error: "--api-key-stdin received no API key line" } :
        validateExplicitKey(line, "--api-key-stdin"));
    }

    if (input.destroyed || input.readableEnded) {
      onEnd();
      return;
    }
    input.once("end", onEnd);
    input.once("close", onEnd);
    input.once("error", onError);
    input.on("data", onData);
  });
}
