import { describe, expect, it } from "vitest";
import type { UserLlmFusionConfig } from "../config/llm-run-mode-config.js";
import type { ProviderPolicy } from "../config/project-constraint-match.js";
import { parseTeamMember } from "../llm/run-mode/fusion-team.js";
import { withSessionFusionDirector, withSessionFusionReviewer, withSessionFusionWorker } from "../session/session-fusion-team.js";
import {
  createSessionTeamChoices,
  fusionTeamRoster,
  resolveSessionDirector,
  resolveSessionReviewer,
  resolveSessionWorker,
  sessionDirectorChoice,
  sessionDirectorOptions,
  teamChoiceMembershipError,
  teamMemberByRef,
} from "./session-director.js";

const fusion: UserLlmFusionConfig = {
  orchestratorProvider: "api",
  workerProvider: "cli",
  team: {
    directors: ["api:model-a", "cli:model-d"],
    workers: ["cli:model-w", "local:model-l"],
    reviewers: ["codex:model-r", "api:model-o"],
  },
};
const all = (): boolean => true;
const policy = (allowed: string[]): Pick<ProviderPolicy, "allows"> => ({ allows: (id) => allowed.includes(id) });
const m = (ref: string) => parseTeamMember(ref)!;

describe("resolveSessionDirector", () => {
  it("is null without a team (today's behaviour)", () => {
    expect(resolveSessionDirector({}, { orchestratorProvider: "api" }, undefined, all)).toBeNull();
    expect(resolveSessionDirector({}, undefined, undefined, all)).toBeNull();
  });

  it("returns the stamped director while the team lists it", () => {
    const metadata = withSessionFusionDirector({}, m("cli:model-d"), 1);
    expect(resolveSessionDirector(metadata, fusion, undefined, all)).toEqual(m("cli:model-d"));
    expect(sessionDirectorChoice(metadata, fusion, undefined, all)?.reason).toBe("stamped");
  });

  it("returns a stamped director the folder refuses, so the turn refuses it out loud", () => {
    const metadata = withSessionFusionDirector({}, m("cli:model-d"), 1);
    expect(resolveSessionDirector(metadata, fusion, policy(["api"]), all)).toEqual(m("cli:model-d"));
  });

  it("forgets a stamped director the team no longer lists", () => {
    const metadata = withSessionFusionDirector({}, m("cli:model-gone"), 1);
    expect(sessionDirectorChoice(metadata, fusion, undefined, all)).toEqual({ member: m("api:model-a"), reason: "default" });
  });

  it("auto-picks the only reachable and allowed director", () => {
    expect(sessionDirectorChoice({}, fusion, undefined, (x) => x.providerId === "cli"))
      .toEqual({ member: m("cli:model-d"), reason: "only" });
    expect(sessionDirectorChoice({}, fusion, policy(["cli"]), all))
      .toEqual({ member: m("cli:model-d"), reason: "only" });
  });

  it("picks the default director among several", () => {
    expect(sessionDirectorChoice({}, fusion, undefined, all)).toEqual({ member: m("api:model-a"), reason: "default" });
    expect(sessionDirectorOptions(fusion, undefined, all).map((x) => x.ref)).toEqual(["api:model-a", "cli:model-d"]);
  });

  it("is null when no director is reachable", () => {
    expect(resolveSessionDirector({}, fusion, undefined, () => false)).toBeNull();
  });
});

describe("resolveSessionWorker", () => {
  it("returns the stamped worker the team lists and the folder allows", () => {
    const metadata = withSessionFusionWorker({}, m("local:model-l"), 1);
    expect(resolveSessionWorker(metadata, fusion, undefined)).toEqual(m("local:model-l"));
    expect(resolveSessionWorker(metadata, fusion, policy(["cli"]))).toBeNull();
    expect(resolveSessionWorker(withSessionFusionWorker({}, m("x:y"), 1), fusion, undefined)).toBeNull();
    expect(resolveSessionWorker({}, fusion, undefined)).toBeNull();
  });
});

describe("resolveSessionReviewer (issue #71)", () => {
  it("returns the stamped reviewer the team lists and the folder allows, or \"none\"", () => {
    const metadata = withSessionFusionReviewer({}, m("codex:model-r"), 1);
    expect(resolveSessionReviewer(metadata, fusion, undefined)).toEqual(m("codex:model-r"));
    // A reviewer the folder refuses is not usable: the team picks among the allowed ones.
    expect(resolveSessionReviewer(metadata, fusion, policy(["api"]))).toBeNull();
    expect(resolveSessionReviewer(withSessionFusionReviewer({}, m("x:y"), 1), fusion, undefined)).toBeNull();
    expect(resolveSessionReviewer(withSessionFusionReviewer({}, "none", 1), fusion, policy([]))).toBe("none");
    expect(resolveSessionReviewer({}, fusion, undefined)).toBeNull();
  });

  it("finds a reviewer a caller names among the team's reviewers only", () => {
    expect(teamMemberByRef(fusion, "reviewers", "api:model-o")).toEqual(m("api:model-o"));
    expect(teamMemberByRef(fusion, "reviewers", "cli:model-w")).toBeNull();
  });
});

describe("createSessionTeamChoices", () => {
  it("holds a turn's choice per session and lets a worker session borrow its parent's", () => {
    const choices = createSessionTeamChoices();
    const release = choices.set("s1", { director: m("api:model-a"), worker: null });
    const releaseWorker = choices.borrow("w1", "s1");
    expect(choices.get("s1")?.director?.ref).toBe("api:model-a");
    expect(choices.get("w1")?.director?.ref).toBe("api:model-a");
    expect(choices.get(undefined)).toBeUndefined();
    releaseWorker();
    expect(choices.get("w1")).toBeUndefined();
    release();
    expect(choices.get("s1")).toBeUndefined();
  });

  it("a stale release does not drop a newer turn's choice", () => {
    const choices = createSessionTeamChoices();
    const first = choices.set("s1", { director: m("api:model-a"), worker: null });
    choices.set("s1", { director: m("cli:model-d"), worker: null });
    first();
    expect(choices.get("s1")?.director?.ref).toBe("cli:model-d");
  });
});

describe("fusionTeamRoster (issue #71)", () => {
  it("lists every member by role with whether it is usable here and why not", () => {
    const roster = fusionTeamRoster(
      { ...fusion, team: { ...fusion.team!, review: "on" } },
      withSessionFusionReviewer(withSessionFusionDirector({}, m("api:model-a"), 1), "none", 2),
      { allowedProviders: ["api", "cli", "local"], folder: "/work/secret" },
      (x) => x.providerId !== "local",
    )!;
    expect(roster.directors).toEqual([
      { ref: "api:model-a", providerId: "api", model: "model-a", usable: true },
      { ref: "cli:model-d", providerId: "cli", model: "model-d", usable: true },
    ]);
    expect(roster.workers[1]).toEqual({
      ref: "local:model-l", providerId: "local", model: "model-l", usable: false, reason: "unreachable",
      why: "local cannot answer now (not configured, signed out or not installed)",
    });
    expect(roster.reviewers[0]).toEqual({
      ref: "codex:model-r", providerId: "codex", model: "model-r", usable: false, reason: "folder",
      why: "this folder (/work/secret) does not allow codex",
    });
    expect(roster.review).toBe("on");
    expect(roster.chat).toEqual({ director: "api:model-a", worker: null, reviewer: "none" });
  });

  it("marks a reviewer whose CLI tools stay on unusable in a restricted chat only", () => {
    const stays = (id: string) => id === "codex";
    const restricted = fusionTeamRoster(fusion, {}, { allowedProviders: ["api", "cli", "local", "codex"], folder: "/w" }, all, stays)!;
    expect(restricted.reviewers[0]).toMatchObject({
      ref: "codex:model-r", usable: false, reason: "cli-tools",
      why: "codex keeps its own read-only shell, which can read outside this restricted folder",
    });
    expect(fusionTeamRoster(fusion, {}, null, all, stays)!.reviewers[0]).toMatchObject({ usable: true });
  });

  it("is null without a team", () => {
    expect(fusionTeamRoster({ orchestratorProvider: "api" }, {}, null, all)).toBeNull();
  });
});

// Issue #74: the HTTP ingress answers 400 for a member the live team does not list.
describe("teamChoiceMembershipError", () => {
  it("accepts listed members, none and team", () => {
    expect(teamChoiceMembershipError(fusion, { director: "api:model-a", worker: "local:model-l", reviewer: "codex:model-r" })).toBeNull();
    expect(teamChoiceMembershipError(fusion, { reviewer: "none" })).toBeNull();
    expect(teamChoiceMembershipError(fusion, { reviewer: "team" })).toBeNull();
    expect(teamChoiceMembershipError(undefined, {})).toBeNull();
  });

  it("names the role a member is missing from, and a missing team", () => {
    expect(teamChoiceMembershipError(fusion, { director: "cli:model-w" })).toMatchObject({ param: "director" });
    expect(teamChoiceMembershipError(fusion, { worker: "api:model-a" })).toMatchObject({ param: "worker" });
    expect(teamChoiceMembershipError(fusion, { reviewer: "api:model-a" })).toMatchObject({ param: "reviewer" });
    expect(teamChoiceMembershipError({ orchestratorProvider: "api" }, { reviewer: "none" })).toMatchObject({ param: "reviewer" });
  });
});
