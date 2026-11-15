import { describe, expect, it } from "vitest";

import { dispatchSlashCommand } from "./commands/slash-command-handler.js";
import {
  formatSessionFusionNotice,
  formatStartupFusionNotice,
} from "./fusion-resume-notice.js";

const run = (runId: string, sessionId: string) => ({
  runId,
  sessionId,
  updatedAt: 1,
  summary: `unfinished Fusion run ${runId}: 1 of 3 tasks done; 2 left`,
});

describe("/fusion (ATO-617)", () => {
  it("lists, resumes and discards", () => {
    expect(dispatchSlashCommand("/fusion").fusionRunAction).toEqual({ action: "list" });
    expect(dispatchSlashCommand("/fusion resume").fusionRunAction).toEqual({ action: "resume" });
    expect(dispatchSlashCommand("/fusion resume fr-1").fusionRunAction).toEqual({
      action: "resume",
      runId: "fr-1",
    });
    expect(dispatchSlashCommand("/fusion discard fr-1").fusionRunAction).toEqual({
      action: "discard",
      runId: "fr-1",
    });
  });

  it("hands /fusion report its flags", () => {
    expect(dispatchSlashCommand("/fusion report").fusionReport).toEqual({ args: [] });
    expect(dispatchSlashCommand("/fusion report --days 7 --model small").fusionReport).toEqual({
      args: ["--days", "7", "--model", "small"],
    });
    expect(dispatchSlashCommand("/fusion report").fusionRunAction).toBeUndefined();
  });

  it("answers a malformed call with its usage", () => {
    for (const buffer of ["/fusion go", "/fusion resume a b", "/fusion fr-1"]) {
      const result = dispatchSlashCommand(buffer);
      expect(result.fusionRunAction).toBeUndefined();
      expect(result.systemMessage).toContain("usage: /fusion");
    }
  });
});

describe("fusion resume notices", () => {
  it("offers the session's own run on open, and says nothing without one", () => {
    expect(formatSessionFusionNotice([])).toBeNull();
    const line = formatSessionFusionNotice([run("fr-1", "s-1")])!;
    expect(line).toMatch(/^Unfinished Fusion run fr-1/);
    expect(line).toContain("/fusion resume");
    expect(line).toContain("/fusion discard");
  });

  it("points at the sessions holding runs at start-up", () => {
    expect(formatStartupFusionNotice([], null)).toBeNull();
    expect(formatStartupFusionNotice([run("fr-1", "s-1")], "s-1")).toBeNull();
    const line = formatStartupFusionNotice([run("fr-1", "s-1"), run("fr-2", "s-2")], null)!;
    expect(line).toContain("2 Fusion runs were cut off");
    expect(line).toContain("s-1");
    expect(line).toContain("/sessions");
  });
});

describe("the start-up notice says which work was cut off", () => {
  const now = 10 * 60 * 60 * 1000;
  const detailed = {
    runId: "fr-1",
    sessionId: "s-1",
    updatedAt: now - 60_000,
    summary: "unfinished Fusion run fr-1: 1 of 3 tasks done; 2 left",
    workingDir: "/work/app",
    request: "Refactor the billing module and add tests",
    startedAt: now - 2 * 60 * 60 * 1000,
    tasksDone: 1,
    tasksLeft: 2,
  };

  it("names the folder, the request, when it started and the tasks done and left", () => {
    const line = formatStartupFusionNotice([detailed], null, now)!;
    expect(line).toContain("/work/app");
    expect(line).toContain('"Refactor the billing module and add tests"');
    expect(line).toContain("started 2h ago");
    expect(line).toContain("1 task done, 2 left");
    expect(line).toContain("/fusion resume");
    expect(line).toContain("/fusion discard");
  });

  it("lists at most three runs and counts the rest", () => {
    const runs = [1, 2, 3, 4].map((i) => ({ ...detailed, runId: `fr-${i}`, sessionId: `s-${i}` }));
    const line = formatStartupFusionNotice(runs, null, now)!;
    expect(line.match(/\/work\/app/g)).toHaveLength(3);
    expect(line).toContain("1 more");
  });
});

