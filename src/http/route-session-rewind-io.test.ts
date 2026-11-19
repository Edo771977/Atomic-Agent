import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("a file the agent created is removed even when it cannot be read (delete needs only stat)", async () => {
    const { a, b, store } = await seed();
    const created = join(harness.workingDir, "created.txt");
    await store.capture("rw-io", created, "os.fs.write");
    writeFileSync(created, "made by the agent");
    io.failRead.add(created);
    const res = await post("rw-io/rewind", point);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ restored: [a, b], deleted: [created], failed: [] });
    expect(existsSync(created)).toBe(false);
  });

  it("a symlink loop (ELOOP) is not restorable, not a retryable failure", async () => {
    const { a, b, store } = await seed();
    rmSync(a);
    symlinkSync(a, a);
    const res = await post("rw-io/rewind", point);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ restored: [b], failed: [], notRestorable: [{ path: a, reason: "not_a_file" }] });
    expect(await copies(store)).toEqual([]);
  });

  it("the preview applies and validates skip like the rollback", async () => {
    const { a, b } = await seed();
    const res = await post("rw-io/rewind/preview", { ...point, skip: [a] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ files: [{ path: b, action: "restore" }], skipped: [a] });
    const plain = await post("rw-io/rewind/preview", point);
    expect(await plain.json()).toMatchObject({ files: [{ path: a, action: "restore" }, { path: b, action: "restore" }], skipped: [] });
    const malformed = await post("rw-io/rewind/preview", { ...point, skip: "a.txt" });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { error: { param: string } }).error.param).toBe("skip");
    const unknown = await post("rw-io/rewind/preview", { ...point, skip: ["nowhere.txt"] });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("skip_unknown");
  });

  /** A first attempt where a is locked: b goes back, a fails; then the person edits both and the lock goes. */
  async function partlyRestoredThenEdited(): Promise<{ a: string; b: string; store: FileCheckpointStore }> {
    const seeded = await seed();
    io.failWrite.add(seeded.a);
    const first = await post("rw-io/rewind", point);
    expect(first.status).toBe(409);
    expect(((await first.json()) as { failed: { path: string }[] }).failed.map((f) => f.path)).toEqual([seeded.a]);
    expect(readFileSync(seeded.b, "utf8")).toBe("b0");
    writeFileSync(seeded.a, "a edited by the person");
    writeFileSync(seeded.b, "b edited by the person");
    io.failWrite.clear();
    return seeded;
  }

  it("skip leaves the files the person chose alone and rolls back the rest", async () => {
    const { a, b, store } = await partlyRestoredThenEdited();
    // A skipped path is not even read for the restore.
    io.failRead.add(a);
    const res = await post("rw-io/rewind", { ...point, skip: [a] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ restored: [b], deleted: [], failed: [], skipped: [a] });
    io.failRead.clear();
    expect(readFileSync(a, "utf8")).toBe("a edited by the person");
    expect(readFileSync(b, "utf8")).toBe("b0");
    expect(turns()).toBe(2);
    expect(await copies(store)).toEqual([]);
  });

  it.each([
    ["a trailing slash", (a: string) => `${a}/`],
    ["a doubled separator", (a: string) => a.replace(/\/a\.txt$/, "//a.txt")],
    ["a dot segment", (a: string) => a.replace(/\/a\.txt$/, "/./a.txt")],
    ["a path relative to the chat's folder", () => "a.txt"],
  ])("skip matches a path written with %s", async (_form, write) => {
    const { a, b } = await partlyRestoredThenEdited();
    const res = await post("rw-io/rewind", { ...point, skip: [write(a)] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ restored: [b], skipped: [a] });
    expect(readFileSync(a, "utf8")).toBe("a edited by the person");
  });

  it("a skip path with no copy since the point is 400 skip_unknown naming it; one already back is accepted", async () => {
    const { a, b } = await seed();
    const unknown = join(harness.workingDir, "never-touched.txt");
    const res = await post("rw-io/rewind", { ...point, skip: [a, unknown] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; param: string; message: string } };
    expect(body.error).toMatchObject({ code: "skip_unknown", param: "skip" });
    expect(body.error.message).toContain(unknown);
    expect(readFileSync(a, "utf8")).toBe("a1");
    expect(turns()).toBe(4);
    // b already holds its saved content: skipping it is accepted and reported.
    writeFileSync(b, "b0");
    const ok = await post("rw-io/rewind", { ...point, skip: [b] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ restored: [a], skipped: [b] });
  });

  it("acceptFailed without skip plans every file again, overwriting the person's edits", async () => {
    const { a, b, store } = await partlyRestoredThenEdited();
    const res = await post("rw-io/rewind", { ...point, acceptFailed: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ restored: [a, b], failed: [], skipped: [] });
    expect(readFileSync(a, "utf8")).toBe("a0");
    expect(readFileSync(b, "utf8")).toBe("b0");
    expect(turns()).toBe(2);
    expect(await copies(store)).toEqual([]);
  });

  it("failures outside skip still refuse with 409 restore_failed", async () => {
    const { a, b, store } = await seed();
    io.failWrite.add(b);
    const res = await post("rw-io/rewind", { ...point, skip: [a] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "restore_failed" }, failed: [{ path: b }], restored: [], skipped: [a] });
    expect(readFileSync(a, "utf8")).toBe("a1");
    expect(turns()).toBe(4);
    expect(await copies(store)).toEqual([a, b]);
  });

  it("refuses a malformed skip with 400 on skip and changes nothing", async () => {
    const { a } = await seed();
    for (const skip of ["a.txt", [""], [1], Array.from({ length: 1001 }, (_, i) => `/p${i}`)]) {
      const res = await post("rw-io/rewind", { ...point, skip });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { param: string } }).error.param).toBe("skip");
    }
    expect(readFileSync(a, "utf8")).toBe("a1");
    expect(turns()).toBe(4);
  });
});

