import { describe, expect, it } from "vitest";

import type { UserFusionTeamConfig } from "../../config/llm-run-mode-config.js";
import { makeProviderPolicy } from "../provider-policy.js";
import type { FusionSetupFacts } from "./fusion-setup-plan.js";
import {
  defaultDirector,
  defaultWorker,
  filterByPolicy,
  memberFamily,
  memberReachable,
  parseTeamMember,
  pickReviewer,
  reviewEnabled,
  reviewPassesOf,
  teamFactsFromSetup,
  teamFamilyOf,
  teamMembers,
  type TeamMember,
  type TeamReachabilityFacts,
} from "./fusion-team.js";

/** Issue #37: the pure helpers behind `llm.runMode.fusion.team`. */
const m = (ref: string): TeamMember => parseTeamMember(ref)!;

const providers = [
  { id: "anthropic", kind: "anthropic" },
  { id: "claude-cli", kind: "subscription-cli", subscriptionCli: "claude" },
  { id: "codex-cli", kind: "subscription-cli", subscriptionCli: "codex" },
  { id: "local-llama", kind: "llama-server" },
  { id: "openai", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1" },
  { id: "lmstudio", kind: "openai-compatible", baseUrl: "http://localhost:1234" },
  { id: "groq", kind: "openai-compatible", baseUrl: "https://api.groq.com/openai" },
  { id: "openrouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
] as const;

const facts = (over: Partial<TeamReachabilityFacts> = {}): TeamReachabilityFacts => ({
  providers: [
    { id: "anthropic", kind: "anthropic", keyState: "present", subscriptionCli: null },
    { id: "claude-cli", kind: "subscription-cli", keyState: "not-needed", subscriptionCli: "claude" },
    { id: "codex-cli", kind: "subscription-cli", keyState: "not-needed", subscriptionCli: "codex" },
    { id: "local-llama", kind: "llama-server", keyState: "not-needed", subscriptionCli: null },
    { id: "openai", kind: "openai-compatible", keyState: "missing", subscriptionCli: null },
  ],
  subscriptionClis: { claude: { state: "ready" }, codex: { state: "signed_out" } },
  ...over,
});

describe("parseTeamMember", () => {
  it("splits at the first colon and keeps the ref", () => {
    expect(parseTeamMember("local-llama:org/model:q4")).toEqual({
      providerId: "local-llama",
      model: "org/model:q4",
      ref: "local-llama:org/model:q4",
    });
  });
  it.each(["", "anthropic", ":model-a", "anthropic:", "anthropic: "])("returns null for %j", (raw) => {
    expect(parseTeamMember(raw)).toBeNull();
  });
  it("lists a team's members by role, empty when the list is unset", () => {
    const team: UserFusionTeamConfig = { directors: ["anthropic:model-a"], reviewers: ["openai:model-b"] };
    expect(teamMembers(team, "directors")).toEqual([m("anthropic:model-a")]);
    expect(teamMembers(team, "workers")).toEqual([]);
    expect(teamMembers(undefined, "directors")).toEqual([]);
  });
});

describe("memberFamily", () => {
  const family = (ref: string) => {
    const member = m(ref);
    return memberFamily(member, providers.find((p) => p.id === member.providerId)!);
  };
  it.each([
    ["anthropic:model-a", "anthropic"],
    ["claude-cli:model-a", "anthropic"],
    ["codex-cli:model-a", "openai"],
    ["local-llama:model-a", "local"],
    ["openai:model-a", "openai"],
    ["lmstudio:model-a", "local"],
    ["groq:model-a", "other"],
    ["openrouter:anthropic/model-a", "anthropic"],
    ["openrouter:openai/model-a", "openai"],
    ["openrouter:qwen/model-a", "other"],
  ] as const)("%s is %s", (ref, expected) => {
    expect(family(ref)).toBe(expected);
  });
  it("takes a bare kind", () => {
    expect(memberFamily(m("x:model-a"), "anthropic")).toBe("anthropic");
    expect(memberFamily(m("x:model-a"), "llama-server")).toBe("local");
    expect(memberFamily(m("x:model-a"), "subscription-cli")).toBe("other");
    expect(memberFamily(m("x:model-a"), "gemini")).toBe("other");
  });
  it("teamFamilyOf reads the provider list and calls an unknown provider other", () => {
    const familyOf = teamFamilyOf(providers);
    expect(familyOf(m("codex-cli:model-a"))).toBe("openai");
    expect(familyOf(m("gone:model-a"))).toBe("other");
  });
});

describe("memberReachable", () => {
  it("a keyed API, a signed-in CLI and the local engine answer", () => {
    expect(memberReachable(facts(), m("anthropic:model-a"))).toBe(true);
    expect(memberReachable(facts(), m("claude-cli:model-a"))).toBe(true);
    expect(memberReachable(facts(), m("local-llama:model-a"))).toBe(true);
  });
  it("a missing key, a signed-out CLI and an unknown provider do not", () => {
    expect(memberReachable(facts(), m("openai:model-a"))).toBe(false);
    expect(memberReachable(facts(), m("codex-cli:model-a"))).toBe(false);
    expect(memberReachable(facts(), m("gone:model-a"))).toBe(false);
  });
  it("an inconclusive CLI check or one not made is not a refusal", () => {
    expect(memberReachable(facts({ subscriptionClis: { claude: { state: "unknown" } } }), m("claude-cli:model-a"))).toBe(true);
    expect(memberReachable(facts({ subscriptionClis: {} }), m("codex-cli:model-a"))).toBe(true);
    expect(memberReachable(facts({ subscriptionClis: { codex: { state: "missing" } } }), m("codex-cli:model-a"))).toBe(false);
  });
  it("the local engine is unreachable only when the facts say so", () => {
    expect(memberReachable(facts({ localReady: false }), m("local-llama:model-a"))).toBe(false);
  });
  it("teamFactsFromSetup derives the local engine's state from setup's facts", () => {
    const setup = {
      ...facts(),
      local: { mode: "managed", url: "", externalAnswers: null, managedModelId: "x", managedModelOnDisk: false, downloadedModelIds: [], recommendedModelId: null },
    } as unknown as FusionSetupFacts;
    expect(teamFactsFromSetup(setup).localReady).toBe(false);
    const external = { ...setup, local: { ...setup.local, mode: "external", externalAnswers: true } } as FusionSetupFacts;
    expect(teamFactsFromSetup(external).localReady).toBe(true);
    expect(memberReachable(teamFactsFromSetup(setup), m("claude-cli:model-a"))).toBe(true);
  });
});

describe("filterByPolicy", () => {
  const members = [m("anthropic:model-a"), m("local-llama:model-b"), m("codex-cli:model-c")];
  it("keeps every member without a policy", () => {
    expect(filterByPolicy(members, undefined)).toEqual(members);
  });
  it("keeps only members whose provider the folder allows", () => {
    const policy = makeProviderPolicy({ key: "/work", matchedDir: "/work", allowedProviders: ["local-llama", "codex-cli"] });
    expect(filterByPolicy(members, policy).map((x) => x.ref)).toEqual(["local-llama:model-b", "codex-cli:model-c"]);
  });
});

describe("defaultDirector", () => {
  const team: UserFusionTeamConfig = { directors: ["anthropic:model-a", "codex-cli:model-b", "codex-cli:model-c"] };
  it("is the director on orchestratorProvider, matching orchestratorModel when set", () => {
    expect(defaultDirector(team, { orchestratorProvider: "codex-cli" })?.ref).toBe("codex-cli:model-b");
    expect(defaultDirector(team, { orchestratorProvider: "codex-cli", orchestratorModel: "model-c" })?.ref).toBe("codex-cli:model-c");
  });
  it("is the first director when orchestratorProvider is unset or not a director", () => {
    expect(defaultDirector(team, {})?.ref).toBe("anthropic:model-a");
    expect(defaultDirector(team, { orchestratorProvider: "local-llama" })?.ref).toBe("anthropic:model-a");
  });
  it("skips directors that cannot answer when given a reachability test", () => {
    const reachable = (x: TeamMember) => x.providerId !== "codex-cli";
    expect(defaultDirector(team, { orchestratorProvider: "codex-cli" }, reachable)?.ref).toBe("anthropic:model-a");
    expect(defaultDirector(team, {}, () => false)).toBeNull();
  });
});

describe("defaultWorker", () => {
  const team: UserFusionTeamConfig = {
    directors: ["anthropic:model-a"],
    workers: ["codex-cli:model-b", "local-llama:model-c", "local-llama:model-d"],
  };
  const all = () => true;
  it("is the workerProvider member when there is one (workerModel picks among several)", () => {
    expect(defaultWorker(team, { workerProvider: "local-llama" }, all)?.ref).toBe("local-llama:model-c");
    expect(defaultWorker(team, { workerProvider: "local-llama", workerModel: "model-d" }, all)?.ref).toBe("local-llama:model-d");
  });
  it("else the first reachable worker", () => {
    expect(defaultWorker(team, { workerProvider: "anthropic" }, all)?.ref).toBe("codex-cli:model-b");
    expect(defaultWorker(team, {}, (x) => x.providerId === "local-llama")?.ref).toBe("local-llama:model-c");
    expect(defaultWorker(team, { workerProvider: "codex-cli" }, (x) => x.providerId !== "codex-cli")?.ref).toBe("local-llama:model-c");
  });
  it("null when no worker is listed or none answers", () => {
    expect(defaultWorker({ directors: ["anthropic:model-a"] }, { workerProvider: "local-llama" }, all)).toBeNull();
    expect(defaultWorker(team, {}, () => false)).toBeNull();
  });
});

describe("pickReviewer", () => {
  const team: UserFusionTeamConfig = {
    directors: ["anthropic:model-a"],
    reviewers: ["local-llama:model-r", "anthropic:model-r", "openai:model-r"],
  };
  const familyOf = teamFamilyOf(providers);
  const all = () => true;
  it("crossFamilyReview (default): the first reachable reviewer of another family than the worker", () => {
    expect(pickReviewer(team, m("local-llama:model-w"), { familyOf, reachable: all })?.ref).toBe("anthropic:model-r");
    expect(pickReviewer(team, m("claude-cli:model-w"), { familyOf, reachable: all })?.ref).toBe("local-llama:model-r");
    expect(pickReviewer(team, m("codex-cli:model-w"), { familyOf, reachable: (x) => x.providerId !== "local-llama" })?.ref)
      .toBe("anthropic:model-r");
  });
  it("null when no reviewer of another family answers, so the caller uses judgeProvider", () => {
    const sameFamily: UserFusionTeamConfig = { directors: ["anthropic:model-a"], reviewers: ["anthropic:model-r"] };
    expect(pickReviewer(sameFamily, m("claude-cli:model-w"), { familyOf, reachable: all })).toBeNull();
    expect(pickReviewer(team, m("local-llama:model-w"), { familyOf, reachable: () => false })).toBeNull();
    expect(pickReviewer({ directors: ["anthropic:model-a"] }, m("local-llama:model-w"), { familyOf, reachable: all })).toBeNull();
  });
  it("crossFamilyReview false: the first reachable reviewer that is not the worker itself", () => {
    const plain = { ...team, crossFamilyReview: false };
    expect(pickReviewer(plain, m("local-llama:model-w"), { familyOf, reachable: all })?.ref).toBe("local-llama:model-r");
    expect(pickReviewer(plain, m("local-llama:model-r"), { familyOf, reachable: all })?.ref).toBe("anthropic:model-r");
  });
});

describe("reviewEnabled and reviewPassesOf (issue #38)", () => {
  const base: UserFusionTeamConfig = { directors: ["anthropic:model-a"] };
  it("listed reviewers turn review on even with the judge off", () => {
    expect(reviewEnabled({ ...base, reviewers: ["openai:model-r"] }, "off")).toBe(true);
    expect(reviewEnabled({ ...base, reviewers: ["openai:model-r"] }, undefined)).toBe(true);
  });
  it("an explicit review setting wins over the judge and the reviewers", () => {
    expect(reviewEnabled({ ...base, reviewers: ["openai:model-r"], review: "off" }, "on")).toBe(false);
    expect(reviewEnabled({ ...base, review: "on" }, "off")).toBe(true);
  });
  it("without reviewers or a team, the judge decides as before", () => {
    expect(reviewEnabled(base, "on")).toBe(true);
    expect(reviewEnabled(base, "off")).toBe(false);
    expect(reviewEnabled(undefined, "on")).toBe(true);
    expect(reviewEnabled(undefined, undefined)).toBe(false);
  });
  it("passes default to 2 and keep an explicit 0", () => {
    expect(reviewPassesOf(undefined)).toBe(2);
    expect(reviewPassesOf(base)).toBe(2);
    expect(reviewPassesOf({ ...base, reviewPasses: 0 })).toBe(0);
    expect(reviewPassesOf({ ...base, reviewPasses: 1 })).toBe(1);
  });
});
