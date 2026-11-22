import { existsSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireSymlinks } from "../test-symlink-support.js";

import { createEmptySessionState, type SessionState } from "../session/index.js";
import { FileCheckpointStore, fileCheckpointsRoot } from "../tools/os/fs/fs-checkpoint-store.js";

import { startTestHarness, type Harness } from "./test-harness.js";

/** Paths whose reads or writes fail, as a lock or a permission would (issue #80). */
const io = vi.hoisted(() => ({ failRead: new Set<string>(), failReadOnce: new Set<string>(), failWrite: new Set<string>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const fail = (code: string, path: unknown): never => {
    throw Object.assign(new Error(`${code}: injected, ${String(path)}`), { code });
  };
  const readFile = ((path: unknown, ...rest: unknown[]) =>
    io.failRead.has(String(path)) || io.failReadOnce.delete(String(path)) ? Promise.reject(Object.assign(new Error(`EACCES: injected, ${String(path)}`), { code: "EACCES" }))
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
  afterEach(async () => { io.failRead.clear(); io.failReadOnce.clear(); io.failWrite.clear(); await harness.cleanup(); });

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

  it("a one-shot EACCES in the preview preserves the rewind point for a fresh confirmation (issue #80)", async () => {
    const { a, b, store } = await seed();
    const transcript = harness.runtime.sessionStore.load("rw-io")?.turns;
    io.failReadOnce.add(a);
    const blocked = await post("rw-io/rewind/preview", point);
    expect(blocked.status).toBe(200);
    const blockedPlan = (await blocked.json()) as { planHash: string };
    expect(blockedPlan).toMatchObject({
      files: [{ path: a, action: "restore", error: expect.stringContaining("EACCES") }, { path: b, action: "restore" }],
      notRestorable: [],
    });
    expect(harness.runtime.sessionStore.load("rw-io")?.turns).toEqual(transcript);
    expect(await copies(store)).toEqual([a, b]);
    expect(readFileSync(a, "utf8")).toBe("a1");
    expect(readFileSync(b, "utf8")).toBe("b1");

    const fresh = await post("rw-io/rewind/preview", point);
    expect(fresh.status).toBe(200);
    const plan = (await fresh.json()) as { planHash: string; files: unknown[] };
    expect(plan.files).toEqual([{ path: a, action: "restore" }, { path: b, action: "restore" }]);
    expect(plan.planHash).not.toBe(blockedPlan.planHash);
    const retry = await post("rw-io/rewind", { ...point, expectPlanHash: plan.planHash });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ restored: [a, b], failed: [] });
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

  it("a symlink loop (ELOOP) is not restorable, not a retryable failure", async (context) => {
    requireSymlinks(context);
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

  it("a file blocked when the request is checked but free inside the turn lock is restored", async () => {
    const { a, b, store } = await seed();
    // Only the first read fails: the plan made when the request is checked.
    io.failReadOnce.add(a);
    const res = await post("rw-io/rewind", point);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ restored: [a, b], failed: [] });
    expect(readFileSync(a, "utf8")).toBe("a0");
    expect(await copies(store)).toEqual([]);
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

  it("skip with acceptFailed: skip wins for its paths, acceptFailed covers the failures of the rest", async () => {
    const { a, b, store } = await partlyRestoredThenEdited();
    io.failWrite.add(b);
    io.failRead.add(a);
    const res = await post("rw-io/rewind", { ...point, skip: [a], acceptFailed: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped: string[]; restored: string[]; failed: { path: string }[] };
    expect(body).toMatchObject({ skipped: [a], restored: [] });
    expect(body.failed.map((f) => f.path)).toEqual([b]);
    io.failRead.clear();
    expect(readFileSync(a, "utf8")).toBe("a edited by the person");
    expect(readFileSync(b, "utf8")).toBe("b edited by the person");
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

  it.each(["cancel", "confirm"] as const)(
    "roll back without the failed file: a fresh preview with skip, then %s (issue #83)",
    async (choice) => {
      const { a, b, store } = await seed();
      // 1. A goes back while B is locked.
      io.failWrite.add(b);
      const first = await post("rw-io/rewind", point);
      expect(first.status).toBe(409);
      const firstBody = (await first.json()) as { restored: string[]; failed: { path: string }[] };
      expect(firstBody.restored).toEqual([a]);
      expect(firstBody.failed.map((f) => f.path)).toEqual([b]);
      // 2. The person edits A, then B is unlocked and edited too.
      writeFileSync(a, "a edited by the person");
      io.failWrite.clear();
      writeFileSync(b, "b edited by the person");
      // 3. The fresh preview with the same skip: A will be overwritten, B is skipped, nothing changes.
      const preview = await post("rw-io/rewind/preview", { ...point, skip: [b] });
      expect(preview.status).toBe(200);
      expect(await preview.json()).toMatchObject({ files: [{ path: a, action: "restore" }], skipped: [b], notRestorable: [] });
      expect(readFileSync(a, "utf8")).toBe("a edited by the person");
      expect(readFileSync(b, "utf8")).toBe("b edited by the person");
      expect(turns()).toBe(4);
      expect(await copies(store)).toEqual([a, b]);
      if (choice === "cancel") {
        // 4. No rollback sent: both edits and every copy stay.
        expect(readFileSync(a, "utf8")).toBe("a edited by the person");
        expect(readFileSync(b, "utf8")).toBe("b edited by the person");
        expect(turns()).toBe(4);
        expect(await copies(store)).toEqual([a, b]);
        return;
      }
      // 5. Confirmed: A gets its original bytes, B keeps the person's, the chat is cut, the copies go.
      const res = await post("rw-io/rewind", { ...point, skip: [b] });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ restored: [a], deleted: [], failed: [], skipped: [b] });
      expect(readFileSync(a, "utf8")).toBe("a0");
      expect(readFileSync(b, "utf8")).toBe("b edited by the person");
      expect(turns()).toBe(2);
      expect(await copies(store)).toEqual([]);
    },
  );

  const previewHash = async (body: object): Promise<string> => {
    const res = await post("rw-io/rewind/preview", { ...point, ...body });
    expect(res.status).toBe(200);
    const { planHash } = (await res.json()) as { planHash: unknown };
    expect(typeof planHash).toBe("string");
    return planHash as string;
  };
  const expectPlanChanged = async (res: Response) => {
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("plan_changed");
    expect(body.error.message).toMatch(/preview/);
  };

  it("a rollback confirmed with the preview's planHash goes ahead (issue #83)", async () => {
    const { a, b, store } = await seed();
    const planHash = await previewHash({});
    expect(await previewHash({})).toBe(planHash);
    const res = await post("rw-io/rewind", { ...point, expectPlanHash: planHash });
    expect(res.status).toBe(200);
    expect(readFileSync(a, "utf8")).toBe("a0");
    expect(readFileSync(b, "utf8")).toBe("b0");
    expect(await copies(store)).toEqual([]);
  });

  it("a listed file edited after the preview refuses with 409 plan_changed and changes nothing (issue #83)", async () => {
    const { a, b, store } = await seed();
    const planHash = await previewHash({});
    writeFileSync(a, "a edited after the preview");
    await expectPlanChanged(await post("rw-io/rewind", { ...point, expectPlanHash: planHash }));
    expect(readFileSync(a, "utf8")).toBe("a edited after the preview");
    expect(readFileSync(b, "utf8")).toBe("b1");
    expect(turns()).toBe(4);
    expect(await copies(store)).toEqual([a, b]);
  });

  it("a file changed by the agent after the preview (a new copy) refuses with 409 plan_changed (issue #83)", async () => {
    const { a, b, store } = await seed();
    const planHash = await previewHash({});
    const c = join(harness.workingDir, "c.txt");
    writeFileSync(c, "c0");
    await store.capture("rw-io", c, "os.fs.edit");
    writeFileSync(c, "c1");
    await expectPlanChanged(await post("rw-io/rewind", { ...point, expectPlanHash: planHash }));
    expect(readFileSync(a, "utf8")).toBe("a1");
    expect(readFileSync(c, "utf8")).toBe("c1");
    expect(turns()).toBe(4);
    expect(await copies(store)).toEqual([a, b, c]);
  });

  /** seed, plus created.txt that the agent made in that turn. */
  async function seedWithCreated(): Promise<{ a: string; b: string; created: string; store: FileCheckpointStore }> {
    const seeded = await seed();
    const created = join(harness.workingDir, "created.txt");
    await seeded.store.capture("rw-io", created, "os.fs.write");
    writeFileSync(created, "made by the agent");
    return { ...seeded, created };
  }

  it("a file to delete replaced by same-size bytes with its mtime kept changes the planHash (issue #87)", async () => {
    const { a, created, store } = await seedWithCreated();
    // A whole-second mtime, so it can be put back exactly.
    utimesSync(created, 1_700_000_000, 1_700_000_000);
    const before = statSync(created);
    const planHash = await previewHash({});
    writeFileSync(created, "made by the human");
    utimesSync(created, 1_700_000_000, 1_700_000_000);
    const after = statSync(created);
    expect([after.size, after.mtimeMs, after.ino]).toEqual([before.size, before.mtimeMs, before.ino]);
    await expectPlanChanged(await post("rw-io/rewind", { ...point, expectPlanHash: planHash }));
    expect(readFileSync(created, "utf8")).toBe("made by the human");
    expect(readFileSync(a, "utf8")).toBe("a1");
    expect(turns()).toBe(4);
    expect(await copies(store)).toHaveLength(3);
  });

  it("a file to delete that cannot be read is fingerprinted by stat and the preview says so (issue #87)", async () => {
    const { created } = await seedWithCreated();
    io.failRead.add(created);
    const res = await post("rw-io/rewind/preview", point);
    const body = (await res.json()) as { files: unknown[]; planHash: string };
    expect(body.files).toContainEqual({ path: created, action: "delete", contentUnchecked: true, contentUncheckedReason: "unreadable" });
    writeFileSync(created, "a longer replacement written by the person");
    await expectPlanChanged(await post("rw-io/rewind", { ...point, expectPlanHash: body.planHash }));
    expect(readFileSync(created, "utf8")).toBe("a longer replacement written by the person");
    // Readable again: the preview no longer flags it.
    io.failRead.clear();
    const again = (await (await post("rw-io/rewind/preview", point)).json()) as { files: unknown[] };
    expect(again.files).toContainEqual({ path: created, action: "delete" });
  });

  /** Another client completes a question and its reply on the chat, touching no file. */
  const anotherTurn = () => {
    const latest = harness.runtime.sessionStore.load("rw-io")!;
    harness.runtime.sessionStore.save({
      ...latest,
      turns: [...latest.turns, { kind: "user", text: "from telegram", at: 300 }, { kind: "assistant_reply", text: "answered", at: 310 }],
      turnCount: latest.turnCount + 1,
      macroTurnStarts: [...(latest.macroTurnStarts ?? []), latest.turns.length + 2],
    });
  };

  it.each([
    ["with its files", {}],
    ["conversation only (files: false)", { files: false }],
  ])("a turn added after the preview refuses an old confirmation, %s (issue #87)", async (_label, extra) => {
    const { a, b, store } = await seed();
    const res = await post("rw-io/rewind/preview", point);
    const { planHash, transcriptRev } = (await res.json()) as { planHash: string; transcriptRev: unknown };
    expect(typeof transcriptRev).toBe("string");
    anotherTurn();
    const confirm = "files" in extra ? { expectTranscriptRev: transcriptRev } : { expectPlanHash: planHash };
    await expectPlanChanged(await post("rw-io/rewind", { ...point, ...extra, ...confirm }));
    expect(turns()).toBe(6);
    expect(readFileSync(a, "utf8")).toBe("a1");
    expect(readFileSync(b, "utf8")).toBe("b1");
    expect(await copies(store)).toEqual([a, b]);
  });

  it("a title or other metadata change after the preview does not invalidate it (issue #87)", async () => {
    await seed();
    const res = await post("rw-io/rewind/preview", point);
    const { planHash, transcriptRev } = (await res.json()) as { planHash: string; transcriptRev: string };
    const latest = harness.runtime.sessionStore.load("rw-io")!;
    harness.runtime.sessionStore.save({ ...latest, metadata: { ...latest.metadata, title: "renamed", note: "x" }, updatedAt: latest.updatedAt + 5 });
    const ok = await post("rw-io/rewind", { ...point, expectPlanHash: planHash, expectTranscriptRev: transcriptRev });
    expect(ok.status).toBe(200);
    expect(turns()).toBe(2);
  });

  it("expectTranscriptRev is validated (issue #87)", async () => {
    await seed();
    for (const expectTranscriptRev of ["", 3, "x".repeat(201)]) {
      const res = await post("rw-io/rewind", { ...point, files: false, expectTranscriptRev });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { param: string } }).error.param).toBe("expectTranscriptRev");
    }
    expect(turns()).toBe(4);
  });

  it("a damaged saved copy leaves the file as it is and the rollback answers restore_failed (issue #87)", async () => {
    const { a, b, store } = await seed();
    const entry = (await store.since("rw-io", 200)).entries.find((e) => e.path === a)!;
    writeFileSync(join(store.sessionDir("rw-io"), entry.file!), "zz");
    const preview = (await (await post("rw-io/rewind/preview", point)).json()) as { files: unknown[] };
    expect(preview.files).toContainEqual({ path: a, action: "restore", error: "saved copy is damaged" });
    const res = await post("rw-io/rewind", point);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "restore_failed" }, restored: [b], failed: [{ path: a, error: "saved copy is damaged" }] });
    expect(readFileSync(a, "utf8")).toBe("a1");
    expect(readFileSync(b, "utf8")).toBe("b0");
    expect(turns()).toBe(4);
    expect(await copies(store)).toEqual([a, b]);
  });

  it("skip is part of the planHash, and expectPlanHash is validated (issue #83)", async () => {
    const { a, b } = await seed();
    const all = await previewHash({});
    const withoutB = await previewHash({ skip: [b] });
    expect(withoutB).not.toBe(all);
    await expectPlanChanged(await post("rw-io/rewind", { ...point, expectPlanHash: all, skip: [b] }));
    for (const expectPlanHash of ["", 7, "x".repeat(201)]) {
      const res = await post("rw-io/rewind", { ...point, expectPlanHash });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { param: string } }).error.param).toBe("expectPlanHash");
    }
    const res = await post("rw-io/rewind", { ...point, expectPlanHash: withoutB, skip: [b] });
    expect(res.status).toBe(200);
    expect(readFileSync(a, "utf8")).toBe("a0");
    expect(readFileSync(b, "utf8")).toBe("b1");
  });

  it("the 400 skip_unknown answer lists the unknown paths as sent, in the preview and the rollback (issue #87)", async () => {
    const { a } = await seed();
    const unknown = [join(harness.workingDir, "a, b.txt"), "./nowhere//x.txt"];
    for (const route of ["rw-io/rewind/preview", "rw-io/rewind"]) {
      const res = await post(route, { ...point, skip: [a, ...unknown] });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string }; unknownSkip: unknown };
      expect(body.error.code).toBe("skip_unknown");
      expect(body.unknownSkip).toEqual(unknown);
    }
    expect(readFileSync(a, "utf8")).toBe("a1");
    expect(turns()).toBe(4);
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

