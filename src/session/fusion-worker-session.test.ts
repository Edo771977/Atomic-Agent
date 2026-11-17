import { describe, it, expect } from "vitest";
import {
  FUSION_WORKER_ID_PREFIX,
  FUSION_WORKER_METADATA_KEY,
  createFusionWorkerSession,
  isFusionWorkerSessionId,
  readFusionWorkerMeta,
} from "./fusion-worker-session.js";

describe("fusion worker sessions", () => {
  const meta = { parentSessionId: "s-parent", taskId: "task-1" };

  it("mints an s-w- id, stamps the metadata, and starts empty", () => {
    const session = createFusionWorkerSession({ workingDir: "/work", meta });
    expect(session.id.startsWith(FUSION_WORKER_ID_PREFIX)).toBe(true);
    expect(isFusionWorkerSessionId(session.id)).toBe(true);
    expect(session.workingDir).toBe("/work");
    expect(session.turns).toEqual([]);
    expect(session.metadata[FUSION_WORKER_METADATA_KEY]).toEqual(meta);
    expect(readFusionWorkerMeta(session.metadata)).toEqual(meta);
  });

  it("carries the operator's whole request for the worker's input guard", () => {
    const withRequest = { ...meta, operatorRequest: "Clean sales.csv" };
    const session = createFusionWorkerSession({ workingDir: "/work", meta: withRequest });
    expect(readFusionWorkerMeta(session.metadata)).toEqual(withRequest);
    expect(
      readFusionWorkerMeta({ [FUSION_WORKER_METADATA_KEY]: { ...meta, operatorRequest: 7 } }),
    ).toEqual(meta);
  });

  it("keeps the stamped egress classes of its parent's policy (issue #33)", () => {
    const providerPolicy = { key: "/w", allowedProviders: ["local-llama"], allowedEgress: ["web"], matchedDir: "/w" };
    expect(readFusionWorkerMeta({ [FUSION_WORKER_METADATA_KEY]: { ...meta, providerPolicy } })?.providerPolicy)
      .toEqual(providerPolicy);
    // A malformed egress list makes the stamp unreadable: the runtime then refuses the worker.
    expect(readFusionWorkerMeta({ [FUSION_WORKER_METADATA_KEY]: { ...meta, providerPolicy: { ...providerPolicy, allowedEgress: "web" } } })?.providerPolicy)
      .toEqual({ key: "(unreadable fusion worker policy)", allowedProviders: [], allowedEgress: [], matchedDir: "" });
  });

  it("keeps the stamped allowedProviderHosts of its parent's policy (issue #60)", () => {
    const providerPolicy = { key: "/w", allowedProviders: ["local-llama"], allowedEgress: [], allowedProviderHosts: ["gpu-box.lan"], matchedDir: "/w" };
    expect(readFusionWorkerMeta({ [FUSION_WORKER_METADATA_KEY]: { ...meta, providerPolicy } })?.providerPolicy)
      .toEqual(providerPolicy);
    expect(readFusionWorkerMeta({ [FUSION_WORKER_METADATA_KEY]: { ...meta, providerPolicy: { ...providerPolicy, allowedProviderHosts: "gpu-box.lan" } } })?.providerPolicy)
      .toEqual({ key: "(unreadable fusion worker policy)", allowedProviders: [], allowedEgress: [], matchedDir: "" });
  });

  it("two workers never share an id", () => {
    const a = createFusionWorkerSession({ workingDir: "/work", meta });
    const b = createFusionWorkerSession({ workingDir: "/work", meta });
    expect(a.id).not.toBe(b.id);
  });

  it("a real session id is not a worker id", () => {
    expect(isFusionWorkerSessionId("s-1234")).toBe(false);
    expect(isFusionWorkerSessionId("")).toBe(false);
  });

  it("readFusionWorkerMeta is defensive about malformed metadata", () => {
    expect(readFusionWorkerMeta(undefined)).toBeNull();
    expect(readFusionWorkerMeta({})).toBeNull();
    expect(
      readFusionWorkerMeta({ [FUSION_WORKER_METADATA_KEY]: null }),
    ).toBeNull();
    expect(
      readFusionWorkerMeta({ [FUSION_WORKER_METADATA_KEY]: "yes" }),
    ).toBeNull();
    expect(
      readFusionWorkerMeta({ [FUSION_WORKER_METADATA_KEY]: [] }),
    ).toBeNull();
    expect(
      readFusionWorkerMeta({
        [FUSION_WORKER_METADATA_KEY]: { parentSessionId: "s" },
      }),
    ).toBeNull();
    expect(
      readFusionWorkerMeta({
        [FUSION_WORKER_METADATA_KEY]: { parentSessionId: "", taskId: "t" },
      }),
    ).toBeNull();
    expect(
      readFusionWorkerMeta({
        [FUSION_WORKER_METADATA_KEY]: { parentSessionId: "s", taskId: 3 },
      }),
    ).toBeNull();
    // Extra keys are dropped, not carried.
    expect(
      readFusionWorkerMeta({
        [FUSION_WORKER_METADATA_KEY]: { ...meta, extra: true },
      }),
    ).toEqual(meta);
  });
});
