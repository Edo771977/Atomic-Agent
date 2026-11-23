import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { readServeKeyFromStdin } from "./serve-api-key-input.js";

it("closes a live stream if the credential does not arrive before the deadline", async () => {
  vi.useFakeTimers();
  try {
    const input = new PassThrough();
    const result = readServeKeyFromStdin(input);
    input.write("synthetic-incomplete-key");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual({ error: "--api-key-stdin timed out waiting for a key line" });
    expect(input.destroyed).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("closes stdin after consuming the line without waiting for EOF", async () => {
  const input = new PassThrough();
  const result = readServeKeyFromStdin(input);
  input.write("synthetic-");
  input.write("pipe-key-value\r\nignored");
  expect(await result).toEqual({ key: "synthetic-pipe-key-value" });
  expect(input.destroyed).toBe(true);
});

it("rejects terminal input before the terminal can echo a key", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const result = readServeKeyFromStdin(input);
  input.end("synthetic-terminal-key\n");
  await expect(result).resolves.toEqual({ error: "--api-key-stdin requires a pipe, not a terminal" });
});
