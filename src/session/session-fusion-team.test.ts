import { describe, expect, it } from "vitest";
import {
  readSessionFusionDirector,
  readSessionFusionWorker,
  SESSION_FUSION_DIRECTOR_METADATA_KEY,
  SESSION_FUSION_WORKER_METADATA_KEY,
  withSessionFusionDirector,
  withSessionFusionWorker,
} from "./session-fusion-team.js";
import { SESSION_LLM_METADATA_KEY } from "./session-llm.js";

describe("session fusion director stamp", () => {
  it("writes and reads back the director, keeping the other metadata", () => {
    const metadata = withSessionFusionDirector(
      { [SESSION_LLM_METADATA_KEY]: { providerId: "cloud", chatModel: "m" } },
      { providerId: "cloud", model: "model-a", ref: "cloud:model-a" },
      1234,
    );
    expect(metadata[SESSION_LLM_METADATA_KEY]).toEqual({ providerId: "cloud", chatModel: "m" });
    expect(metadata[SESSION_FUSION_DIRECTOR_METADATA_KEY]).toEqual({
      member: "cloud:model-a",
      providerId: "cloud",
      model: "model-a",
      chosenAt: 1234,
    });
    expect(readSessionFusionDirector(metadata)).toEqual({
      member: "cloud:model-a",
      providerId: "cloud",
      model: "model-a",
      chosenAt: 1234,
    });
  });

  it("reads a malformed stamp as none", () => {
    for (const raw of [
      null,
      "cloud:model-a",
      [],
      { member: "cloud:model-a" },
      { member: "cloud:model-a", providerId: "other", model: "model-a", chosenAt: 1 },
      { member: "cloud:model-b", providerId: "cloud", model: "model-a", chosenAt: 1 },
      { member: "nocolon", providerId: "nocolon", model: "", chosenAt: 1 },
    ]) {
      expect(readSessionFusionDirector({ [SESSION_FUSION_DIRECTOR_METADATA_KEY]: raw })).toBeNull();
    }
    expect(readSessionFusionDirector(undefined)).toBeNull();
  });

  it("keeps a stamp whose chosenAt is missing or bad, as 0", () => {
    expect(
      readSessionFusionDirector({
        [SESSION_FUSION_DIRECTOR_METADATA_KEY]: { member: "c:m", providerId: "c", model: "m", chosenAt: "x" },
      }),
    ).toEqual({ member: "c:m", providerId: "c", model: "m", chosenAt: 0 });
  });

  it("keeps a model that itself holds a colon", () => {
    const metadata = withSessionFusionDirector({}, { providerId: "router", model: "vendor/m:free", ref: "router:vendor/m:free" }, 5);
    expect(readSessionFusionDirector(metadata)?.model).toBe("vendor/m:free");
  });

  it("clears the stamp when written with null", () => {
    const metadata = withSessionFusionDirector(
      { [SESSION_FUSION_DIRECTOR_METADATA_KEY]: { member: "c:m", providerId: "c", model: "m", chosenAt: 1 }, other: 1 },
      null,
    );
    expect(metadata).toEqual({ other: 1 });
  });
});

describe("session fusion worker stamp", () => {
  it("writes, reads and clears the preferred worker", () => {
    const metadata = withSessionFusionWorker({}, { providerId: "w", model: "model-b", ref: "w:model-b" }, 9);
    expect(metadata[SESSION_FUSION_WORKER_METADATA_KEY]).toEqual({
      member: "w:model-b", providerId: "w", model: "model-b", chosenAt: 9,
    });
    expect(readSessionFusionWorker(metadata)?.member).toBe("w:model-b");
    expect(readSessionFusionWorker(withSessionFusionWorker(metadata, null))).toBeNull();
  });
});
