import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptySessionState, type SessionState } from "../session/index.js";
import { FileCheckpointStore, fileCheckpointsRoot } from "../tools/os/fs/fs-checkpoint-store.js";

import { startTestHarness, type Harness } from "./test-harness.js";

/** Paths whose reads or writes fail, as a lock or a permission would (issue #80). */
const io = vi.hoisted(() => ({ failRead: new Set<string>(), failWrite: new Set<string>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const fail = (code: string, path: unknown): never => {
    throw Object.assign(new Error(`${code}: injected, ${String(path)}`), { code });
  };
  const readFile = ((path: unknown, ...rest: unknown[]) =>
    io.failRead.has(String(path)) ? Promise.reject(Object.assign(new Error(`EACCES: injected, ${String(path)}`), { code: "EACCES" }))
      : (actual.readFile as (...a: unknown[]) => Promise<unknown>)(path, ...rest)) as typeof actual.readFile;
  const writeFile = ((path: unknown, ...rest: unknown[]) => {
    if (io.failWrite.has(String(path))) return Promise.resolve().then(() => fail("EBUSY", path));
    return (actual.writeFile as (...a: unknown[]) => Promise<void>)(path, ...rest);
  }) as typeof actual.writeFile;
  const mocked = { ...actual, readFile, writeFile };
  return { ...mocked, default: mocked };
});

describe("rewind with files the disk will not let it read or write (issue #80)", () => {
  let harness: Harness;
  beforeEach(async () => { harness = await startTestHarness(); });
  afterEach(async () => { io.failRead.clear(); io.failWrite.clear(); await harness.cleanup(); });

  const post = (path: string, body: unknown) => fetch(`${harness.baseUrl}/api/sessions/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const point = { priorQuestions: 1, expectText: "change it" };

  /** q1 "change it" (at 200) edited a.txt and b.txt from "a0"/"b0" to "a1"/"b1". */
  async function seed(id = "rw-io"): Promise<{ a: string; b: string; store: FileCheckpointStore }> {
    const state: SessionState = {
      ...createEmptySessionState({ id, workingDir: harness.workingDir }),
      status: "completed",
      turns: [
        { kind: "user", text: "make them", at: 100 },
        { kind: "assistant_reply", text: "made", at: 110 },
        { kind: "user", text: "change it", at: 200 },
        { kind: "assistant_reply", text: "changed", at: 250 },
      ],
      turnCount: 2,
      macroTurnStarts: [2, 4],
    };
    harness.runtime.sessionStore.save(state);
    const a = join(harness.workingDir, "a.txt");
    const b = join(harness.workingDir, "b.txt");
    writeFileSync(a, "a0");
    writeFileSync(b, "b0");
    const store = new FileCheckpointStore(fileCheckpointsRoot(harness.runtime.config.paths.stateDir), () => 210);
    await store.capture(id, a, "os.fs.edit");
    writeFileSync(a, "a1");
    await store.capture(id, b, "os.fs.edit");
    writeFileSync(b, "b1");
    return { a, b, store };
  }
  const turns = (id = "rw-io") => harness.runtime.sessionStore.load(id)?.turns.length;
  const copies = async (store: FileCheckpointStore, id = "rw-io") => (await store.since(id, 200)).entries.map((e) => e.path);

  it("a file that cannot be read while planning is a failure, not 'not a file': the chat and copies stay", async () => {
    const { a, b, store } = await seed();
    io.failRead.add(a);
    const first = await post("rw-io/rewind", point);
    expect(first.status).toBe(409);
    const body = (await first.json()) as { error: { code: string }; failed: { path: string }[]; restored: string[]; notRestorable: unknown[] };
    expect(body.error.code).toBe("restore_failed");
    expect(body.failed.map((f) => f.path)).toEqual([a]);
    expect(body.restored).toEqual([b]);
    expect(body.notRestorable).toEqual([]);
    expect(turns()).toBe(4);
    expect(await copies(store)).toEqual([a, b]);
    expect(readFileSync(a, "utf8")).toBe("a1");
    // The preview says the same: a will be tried and cannot be checked now.
    const preview = await post("rw-io/rewind/preview", point);
    expect(((await preview.json()) as { files: unknown }).files).toEqual([{ path: a, action: "restore", error: expect.stringContaining("EACCES") }]);
    // Released: the retry puts the original bytes back, and only then cleans up.
    io.failRead.clear();
    const retry = await post("rw-io/rewind", point);
    expect(retry.status).toBe(200);
    expect(readFileSync(a, "utf8")).toBe("a0");
    expect(readFileSync(b, "utf8")).toBe("b0");
    expect(turns()).toBe(2);
    expect(await copies(store)).toEqual([]);
  });
});

