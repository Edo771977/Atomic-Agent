import { describe, expect, it } from "vitest";
import { FUSION_WORKER_METADATA_KEY } from "../session/fusion-worker-session.js";
import { fusionWorkerParents } from "./fusion-worker-parents.js";

describe("fusionWorkerParents", () => {
  it("walks the live worker metadata up to the top orchestrator", () => {
    const meta = (parentSessionId: string) => ({ [FUSION_WORKER_METADATA_KEY]: { parentSessionId, taskId: "t" } });
    const live: Record<string, Record<string, unknown>> = { "s-w-2": meta("s-w-1"), "s-w-1": meta("s-top") };
    expect(fusionWorkerParents("s-w-2", (id) => live[id])).toEqual(["s-w-1", "s-top"]);
    expect(fusionWorkerParents("s-top", (id) => live[id])).toEqual([]);
  });
});
