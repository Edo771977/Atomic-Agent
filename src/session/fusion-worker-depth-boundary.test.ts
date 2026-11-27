import { describe, expect, it } from "vitest";
import * as workers from "./fusion-worker-session.js";

describe("C1a worker depth preserves fork boundaries", () => {
  it("records depth without losing the full input request or provider restrictions", () => {
    const providerPolicy = {
      key: "/project", matchedDir: "/project", allowedProviders: ["local-llama"],
      allowedEgress: [], allowedProviderHosts: ["gpu.example.invalid"],
    };
    const meta = { parentSessionId: "s-parent", taskId: "task", operatorRequest: "Protect input.csv", providerPolicy };
    const worker = workers.createFusionWorkerSession({ workingDir: "/copy", meta });
    expect(workers.readFusionWorkerMeta(worker.metadata)).toEqual({ ...meta, depth: 1 });
  });

  it("increments ancestry and keeps malformed policy fail closed", () => {
    const metadata = { [workers.FUSION_WORKER_METADATA_KEY]: {
      parentSessionId: "s-parent", taskId: "task", depth: 4, providerPolicy: { allowedProviders: "invalid" },
    } };
    expect(workers.readFusionWorkerMeta(metadata)).toMatchObject({
      depth: 4, providerPolicy: { allowedProviders: [], allowedEgress: [] },
    });
    expect(workers).toHaveProperty("childFusionWorkerDepth");
    const childDepth = (workers as unknown as { childFusionWorkerDepth(value: typeof metadata): number }).childFusionWorkerDepth;
    expect(childDepth(metadata)).toBe(5);
  });
});
