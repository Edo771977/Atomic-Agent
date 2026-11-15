import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeProviderPolicy, runWithProviderPolicy } from "../llm/provider-policy.js";
import { createRuntimeSessionFactories } from "./composition/runtime-session-services.js";
import { channelNotifyRefusal, createSessionProviderPolicy } from "./session-provider-policy.js";

describe("session provider policy (issue #33)", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), "pc-session-"));
    const project = join(root, "client");
    const config = { projects: { roots: [], constraints: { [project]: { allowedProviders: ["local-llama"] } } } };
    const stored = new Map<string, { workingDir: string }>([["s-1", { workingDir: join(project, "src") }]]);
    const policy = createSessionProviderPolicy({
      readConfig: () => config,
      loadSession: (id) => stored.get(id) ?? null,
    });
    return { project, config, policy };
  }

  it("derives a stored session's policy from its folder", () => {
    const { project, policy } = setup();
    expect(policy.forSessionId("s-1")?.key).toBe(project);
    expect(policy.forSessionId("s-1")?.allows("openai")).toBe(false);
  });

  it("reads a side call's partition id (`reflection:<id>`) as its session's id", () => {
    const { project, policy } = setup();
    expect(policy.forSessionId("reflection:s-1")?.key).toBe(project);
    expect(policy.forSessionId("compaction:s-1")?.key).toBe(project);
    expect(policy.forSessionId("reflection:s-gone")?.allowedProviders).toEqual([]);
  });

  it("fails closed for an id that names no stored session", () => {
    const { policy } = setup();
    expect(policy.forSessionId("s-gone")?.allowedProviders).toEqual([]);
  });

  it("a worker in a temp copy inherits the parent's constraint instead of re-deriving it", () => {
    const { project, policy } = setup();
    const temp = mkdtempSync(join(tmpdir(), "pc-worker-copy-"));
    try {
      const factories = createRuntimeSessionFactories(project, { save: () => {} }, () => null);
      const parentPolicy = makeProviderPolicy({ key: project, allowedProviders: ["local-llama"], matchedDir: project });
      const worker = runWithProviderPolicy(parentPolicy, () =>
        factories.createEphemeralSession({ parentSessionId: "s-1", taskId: "t1" }, temp, true));
      // The temp copy is outside every constrained folder...
      expect(policy.forWorkingDir(temp)).toBeUndefined();
      // ...and the worker still carries its parent's constraint.
      const inherited = policy.forSession(worker);
      expect(inherited?.key).toBe(project);
      expect(inherited?.allows("local-llama")).toBe(true);
      expect(inherited?.allows("openai")).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("a worker of an unconstrained parent runs unconstrained; an unstamped worker is refused everything", () => {
    const { project, policy } = setup();
    const factories = createRuntimeSessionFactories(project, { save: () => {} }, () => null);
    const free = runWithProviderPolicy(undefined, () =>
      factories.createEphemeralSession({ parentSessionId: "s-1", taskId: "t1" }, project));
    expect(policy.forSession(free)).toBeUndefined();
    const unstamped = factories.createEphemeralSession({ parentSessionId: "s-1", taskId: "t2" }, tmpdir());
    expect(policy.forSession(unstamped)?.allowedProviders).toEqual([]);
  });

  describe("effectivePolicyForSession (the one read the egress guard makes)", () => {
    it("is the frame's policy while a turn runs, constrained or not", () => {
      const { policy } = setup();
      const turn = makeProviderPolicy({ key: "/x", allowedProviders: [], allowedEgress: ["web"], matchedDir: "/x" });
      expect(runWithProviderPolicy(turn, () => policy.effectivePolicyForSession("s-1"))?.allowsEgress("web")).toBe(true);
      expect(runWithProviderPolicy(undefined, () => policy.effectivePolicyForSession("s-1"))).toBeUndefined();
    });

    it("ignores a frame that belongs to another session (a task drained inside some turn)", () => {
      const { project, policy } = setup();
      const other = makeProviderPolicy({ key: "/x", allowedProviders: [], allowedEgress: ["web"], matchedDir: "/x" });
      const seen = runWithProviderPolicy(other, () => policy.effectivePolicyForSession("s-1"), { sessionId: "s-other" });
      expect(seen?.key).toBe(project);
      expect(runWithProviderPolicy(other, () => policy.effectivePolicyForSession("s-other"), { sessionId: "s-other" })?.key).toBe("/x");
    });

    it("takes a session object, so a chat session not stored yet reads its own folder", () => {
      const { project, policy } = setup();
      expect(policy.effectivePolicyForSession({ id: "s-new", workingDir: join(project, "x") })?.key).toBe(project);
      expect(policy.effectivePolicyForSession({ id: "s-new", workingDir: tmpdir() })).toBeUndefined();
    });

    it("re-derives the session's folder without a frame, and refuses an unknown id", () => {
      const { project, policy } = setup();
      expect(policy.effectivePolicyForSession("s-1")?.key).toBe(project);
      expect(policy.effectivePolicyForSession("s-1")?.allowsEgress("web")).toBe(false);
      expect(policy.effectivePolicyForSession("s-gone")?.allowsEgress("web")).toBe(false);
    });

    it("carries a fusion worker's stamped egress classes", () => {
      const { project, policy } = setup();
      const temp = mkdtempSync(join(tmpdir(), "pc-worker-egress-"));
      try {
        const factories = createRuntimeSessionFactories(project, { save: () => {} }, () => null);
        const parentPolicy = makeProviderPolicy({ key: project, allowedProviders: ["local-llama"], allowedEgress: ["github"], matchedDir: project });
        const worker = runWithProviderPolicy(parentPolicy, () =>
          factories.createEphemeralSession({ parentSessionId: "s-1", taskId: "t1" }, temp, true));
        const inherited = policy.forSession(worker);
        expect(inherited?.allowsEgress("github")).toBe(true);
        expect(inherited?.allowsEgress("web")).toBe(false);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    });
  });

  describe("channelNotifyRefusal (a task's notification, at send time)", () => {
    it("refuses a constrained session without channels, allows one with it, and leaves unconstrained ones alone", () => {
      const { project, config, policy } = setup();
      expect(channelNotifyRefusal(policy, "s-1")).toContain(`folder ${project} is restricted`);
      config.projects.constraints[project] = { allowedProviders: ["local-llama"], allowedEgress: ["channels"] } as never;
      expect(channelNotifyRefusal(policy, "s-1")).toBeNull();
      config.projects.constraints = {} as never;
      expect(channelNotifyRefusal(policy, "s-1")).toBeNull();
    });

    it("refuses a task with no session while constraints exist (fail closed)", () => {
      const { policy } = setup();
      expect(channelNotifyRefusal(policy, null)).not.toBeNull();
    });
  });
});
