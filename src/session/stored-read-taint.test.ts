import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { userTurn } from "./conversation-turn.js";
import { SessionStore } from "./session-store.js";
import { createEmptySessionState, recordTurn, type SessionState } from "./session-state.js";
import { mergeReadTaintStamps, READ_TAINT_METADATA_KEY, withReadTaintFrom } from "./stored-read-taint.js";
import type { TurnOwnerProbe } from "./turn-owner.js";
import type { TurnProgress } from "./turn-progress.js";

const SECRET = { key: "/secret", allowedProviders: ["local-llama", "openai"], allowedEgress: ["web"], matchedDir: "/secret", readFrom: ["/secret"] };
const OTHER = { key: "/other", allowedProviders: ["local-llama"], allowedEgress: [], matchedDir: "/other", readFrom: ["/other"] };

describe("stored read taint merge", () => {
  it("intersects two stamps and keeps an unreadable one (fail closed)", () => {
    expect(mergeReadTaintStamps(undefined, SECRET)).toBe(SECRET);
    expect(mergeReadTaintStamps(SECRET, undefined)).toBe(SECRET);
    expect(mergeReadTaintStamps(SECRET, OTHER)).toMatchObject({
      key: "/secret + /other",
      allowedProviders: ["local-llama"],
      allowedEgress: [],
      readFrom: ["/secret", "/other"],
    });
    expect(mergeReadTaintStamps("garbage", SECRET)).toBe("garbage");
    expect(mergeReadTaintStamps(SECRET, { key: 1 })).toEqual({ key: 1 });
  });

  it("returns the state itself when its own taint already carries the other", () => {
    const state = { metadata: { [READ_TAINT_METADATA_KEY]: { ...SECRET } } };
    expect(withReadTaintFrom(state, SECRET)).toBe(state);
    expect(withReadTaintFrom(state, undefined)).toBe(state);
  });
});

describe("SessionStore keeps a stored read taint (issue #74)", () => {
  let tmp: string;
  let store: SessionStore;
  const probe: TurnOwnerProbe = { pid: 100, host: "darwin", hostUptime: () => 50_000, isAlive: () => true, processStartOf: () => null };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-taint-store-"));
    store = new SessionStore({ dbFile: join(tmp, "sessions.sqlite"), turnOwnerProbe: probe });
  });
  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const fresh = (id: string, metadata: Record<string, unknown> = {}): SessionState => ({
    ...createEmptySessionState({ id, workingDir: "/w" }),
    updatedAt: 5_000,
    metadata,
  });

  it("a save from a copy without the taint keeps the stored one", () => {
    store.save(fresh("s1", { [READ_TAINT_METADATA_KEY]: SECRET }));
    store.save(fresh("s1"));
    expect(store.load("s1")!.metadata[READ_TAINT_METADATA_KEY]).toEqual(SECRET);
  });

  it("a turn's checkpoint and end from a copy read before the taint keep it", () => {
    const before = fresh("s2");
    store.save(before);
    expect(store.beginTurn("s2", 6_000)).toBe(true);
    // A tool (another process, a Fusion worker, a move) tainted the row meanwhile.
    store.save({ ...before, metadata: { [READ_TAINT_METADATA_KEY]: SECRET } });
    const progress: TurnProgress = { stepsDone: 1, lastStepIndex: 0, request: "go", options: {}, resumes: 0, startedAt: 6_000, updatedAt: 6_500 };
    expect(store.checkpointTurn(recordTurn(before, userTurn("go")), progress)).toBe(true);
    expect(store.load("s2")!.metadata[READ_TAINT_METADATA_KEY]).toEqual(SECRET);
    store.finishTurn({ ...recordTurn(before, userTurn("go")), status: "completed" });
    expect(store.load("s2")!.metadata[READ_TAINT_METADATA_KEY]).toEqual(SECRET);
  });

  it("intersects the stored taint with a different incoming one", () => {
    store.save(fresh("s3", { [READ_TAINT_METADATA_KEY]: SECRET }));
    store.save(fresh("s3", { [READ_TAINT_METADATA_KEY]: OTHER }));
    expect(store.load("s3")!.metadata[READ_TAINT_METADATA_KEY]).toMatchObject({
      allowedProviders: ["local-llama"],
      allowedEgress: [],
      readFrom: expect.arrayContaining(["/secret", "/other"]),
    });
  });

  it("an unreadable stored stamp stays (it refuses every provider)", () => {
    store.save(fresh("s4", { [READ_TAINT_METADATA_KEY]: "unreadable" }));
    store.save(fresh("s4"));
    expect(store.load("s4")!.metadata[READ_TAINT_METADATA_KEY]).toBe("unreadable");
  });
});
