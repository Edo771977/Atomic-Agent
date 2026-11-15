import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolContext } from "../tool-registry.js";
import { makeProviderPolicy, runWithProviderPolicy, type ProviderPolicy } from "../../llm/provider-policy.js";
import { MemoryStore } from "../../memory/memory-store.js";
import { ProfileStore } from "../../memory/profile-store.js";
import { buildNotesStoreTool } from "./notes-store.js";
import { buildNotesRecallTool } from "./notes-recall.js";
import { buildNotesForgetTool } from "./notes-forget.js";
import { buildProfileSetTool } from "./profile-set.js";
import { buildProfileListTool } from "./profile-list.js";

/**
 * Issue #33 group C: the memory tools run inside the turn's provider-
 * policy frame, so what a constrained folder stores is recalled only in
 * a session its constraint lets see it.
 */
const ctx = (workingDir: string): ToolContext => ({
  workingDir,
  sessionId: "s1",
  stepIndex: 0,
  signal: new AbortController().signal,
});

const secret = makeProviderPolicy({ key: "/work/secret", allowedProviders: ["local-llama"], matchedDir: "/work/secret" });
const other = makeProviderPolicy({ key: "/work/other", allowedProviders: ["openai"], matchedDir: "/work/other" });

describe("memory tools under per-folder provider constraints", () => {
  let tmp: string;
  let notes: MemoryStore;
  let profile: ProfileStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-scope-tools-"));
    notes = new MemoryStore({ dbFile: join(tmp, "memory.sqlite"), maxEntries: 100 });
    profile = new ProfileStore({ dbFile: join(tmp, "memory.sqlite") });
  });

  afterEach(() => {
    profile.close();
    notes.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const inFrame = <T>(policy: ProviderPolicy | undefined, fn: () => Promise<T>): Promise<T> =>
    runWithProviderPolicy(policy, fn);

  it("memory.notes.store / recall / forget honour the folder's scope", async () => {
    const store = buildNotesStoreTool({ store: notes, maxContentChars: 4000 });
    const recall = buildNotesRecallTool({ store: notes, defaultK: 5 });
    const forget = buildNotesForgetTool({ store: notes });
    const stored = await inFrame(secret, () => store.run({ content: "bluebird ships on friday" }, ctx("/work/secret")));
    const id = stored.details.id as number;

    const ids = async (policy: ProviderPolicy | undefined): Promise<number[]> =>
      ((await inFrame(policy, () => recall.run({ query: "bluebird" }, ctx("/elsewhere")))).details.entries as Array<{ id: number }>)
        .map((e) => e.id);
    expect(await ids(undefined)).toEqual([]);
    expect(await ids(other)).toEqual([]);
    expect(await ids(secret)).toEqual([id]);

    const byId = await inFrame(undefined, () => recall.run({ id }, ctx("/elsewhere")));
    expect(byId.details.entries ?? []).toEqual([]);

    const removed = await inFrame(undefined, () => forget.run({ id }, ctx("/elsewhere")));
    expect(removed.details.removed).toBe(false);
    expect(await ids(secret)).toEqual([id]);
  });

  it("memory.profile.set / list keep a constrained fact in its folder", async () => {
    const set = buildProfileSetTool({ store: profile });
    const list = buildProfileListTool({ store: profile });
    const ok = await inFrame(secret, () => set.run({ key: "client", value: "Bluebird Corp" }, ctx("/work/secret")));
    expect(ok.status).toBe("ok");
    const keys = async (policy: ProviderPolicy | undefined): Promise<string> =>
      JSON.stringify((await inFrame(policy, () => list.run({}, ctx("/elsewhere")))).details.facts);
    expect(await keys(undefined)).not.toContain("Bluebird");
    expect(await keys(secret)).toContain("Bluebird");
    const refused = await inFrame(undefined, () => set.run({ key: "client", value: "Other" }, ctx("/elsewhere")));
    expect(refused.status).toBe("error");
  });
});
