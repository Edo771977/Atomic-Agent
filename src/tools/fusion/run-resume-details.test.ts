import { describe, expect, it } from "vitest";

import type { FusionRunCheckpoint } from "./run-checkpoint.js";
import { resumableRunDetails } from "./run-resume.js";

function checkpoint(over: Partial<FusionRunCheckpoint> = {}): FusionRunCheckpoint {
  return {
    version: 1 as FusionRunCheckpoint["version"],
    runId: "fr-1",
    sessionId: "s-1",
    workingDir: "/work/app",
    originalRequest: "Refactor the billing module\n  and add tests for every currency we support, including the odd ones like JPY and KWD",
    args: {},
    state: "interrupted",
    owner: "x",
    waveCount: 1,
    wavesDone: 0,
    tasks: [
      { id: "t1", title: "a", sideEffects: false, sideEffectTools: [], result: { status: "ok" } as never },
      { id: "t2", title: "b", sideEffects: false, sideEffectTools: [] },
      { id: "t3", title: "c", sideEffects: false, sideEffectTools: [] },
    ],
    spentUsd: 0,
    startedAt: 1_000,
    updatedAt: 2_000,
    resumes: 0,
    ...over,
  };
}

describe("resumableRunDetails", () => {
  it("names the folder, a one-line preview of the request, the start and the counts", () => {
    const d = resumableRunDetails(checkpoint());
    expect(d).toEqual({
      workingDir: "/work/app",
      request: "Refactor the billing module and add tests for every currency we support, includi…",
      startedAt: 1_000,
      tasksDone: 1,
      tasksLeft: 2,
    });
    expect(d.request!.length).toBeLessThanOrEqual(81);
  });

  it("has no request when the runtime did not know it", () => {
    expect(resumableRunDetails(checkpoint({ originalRequest: undefined })).request).toBeNull();
  });
});
