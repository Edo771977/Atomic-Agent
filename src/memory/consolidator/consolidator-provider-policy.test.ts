import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertProviderAllowed, makeProviderPolicy, runWithProviderPolicy } from "../../llm/provider-policy.js";
import { MemoryStore } from "../memory-store.js";
import { LinkStore } from "../links/link-store.js";
import { LessonStore } from "../lessons/lesson-store.js";
import { ConsolidatorJob } from "./consolidator-job.js";
import { DistillRunner } from "./distill-runner.js";

/**
 * Issue #33 group C: the consolidator's timer has neither a frame nor a
 * session. While any constraint exists it must still consolidate
 * unconstrained notes, and consolidate a constrained folder's notes only
 * through a provider that folder allows.
 */
describe("consolidator under per-folder provider constraints", () => {
  let dir: string;
  let memoryStore: MemoryStore;
  let lessonStore: LessonStore;
  let job: ConsolidatorJob;
  let calls: string[];
  let linkStore: LinkStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-consolidator-policy-"));
    const dbFile = join(dir, "memory.sqlite");
    memoryStore = new MemoryStore({ dbFile, maxEntries: 100 });
    lessonStore = new LessonStore({ dbFile });
    calls = [];
    linkStore = new LinkStore({ db: memoryStore.getDatabaseHandleForEmbeddings() });
    const distillRunner = new DistillRunner({
      // The provider this job reaches is "cloud", checked the way the
      // guarded registry checks it (constraints are configured).
      llmComplete: async () => {
        assertProviderAllowed("cloud", { constraintsActive: () => true });
        calls.push("cloud");
        return {
          content: `LESSON activation="When deploying"; principle="Run the deploy script."\n`,
          reasoningContent: null,
          finishReason: "stop",
          usage: null,
        } as never;
      },
      slotId: -1,
      timeoutMs: 5000,
    });
    job = new ConsolidatorJob(
      {
        enabled: true,
        intervalMs: 60_000,
        cooldownMs: 0,
        minClusterSize: 3,
        maxClustersPerTick: 5,
        requireSharedTag: true,
        consolidationLeaseMs: 60_000,
      },
      {
        memoryStore,
        linkStore,
        lessonStore,
        distillRunner,
      },
    );
  });

  afterEach(() => {
    lessonStore.close();
    memoryStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // A cluster is a linked component of notes sharing a tag.
  const seed = (tag: string): void => {
    const ids = [0, 1, 2].map((i) => memoryStore.store({ content: `deploy note ${tag} ${i}`, tags: [tag] }, 1_000 + i).id);
    linkStore.add({ fromId: ids[0]!, toId: ids[1]!, kind: "RELATES_TO" });
    linkStore.add({ fromId: ids[1]!, toId: ids[2]!, kind: "RELATES_TO" });
  };

  it("consolidates unconstrained notes and skips a folder whose constraint refuses the provider", async () => {
    runWithProviderPolicy(undefined, () => seed("public"));
    const local = makeProviderPolicy({ key: "/work/secret", allowedProviders: ["local-llama"], matchedDir: "/work/secret" });
    const secretIds = runWithProviderPolicy(local, () => {
      seed("secret");
      return memoryStore.list().filter((e) => e.tags.includes("secret")).map((e) => e.id);
    });

    const result = await job.runOnce();

    expect(result.lessonsCreated).toBe(1);
    expect(result.failures).toBe(0);
    expect(result.clustersSkippedByPolicy).toBe(1);
    expect(calls).toEqual(["cloud"]);
    // The refused folder's notes stay as they were: not archived.
    for (const id of secretIds) expect(memoryStore.getConsolidatedInto(id)).toBeNull();
    // The lesson is unconstrained.
    expect(runWithProviderPolicy(undefined, () => lessonStore.listIndex()).length).toBe(1);
  });

  it("consolidates a constrained folder's notes when its constraint allows the provider, keeping the lesson scoped", async () => {
    const cloud = makeProviderPolicy({ key: "/work/cloudy", allowedProviders: ["cloud"], matchedDir: "/work/cloudy" });
    runWithProviderPolicy(cloud, () => seed("cloudy"));

    const result = await job.runOnce();

    expect(result.lessonsCreated).toBe(1);
    expect(runWithProviderPolicy(undefined, () => lessonStore.listIndex())).toEqual([]);
    expect(runWithProviderPolicy(cloud, () => lessonStore.listIndex()).length).toBe(1);
  });
});
