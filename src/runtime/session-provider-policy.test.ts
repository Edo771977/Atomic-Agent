import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeProviderPolicy, runWithProviderPolicy } from "../llm/provider-policy.js";
import { createRuntimeSessionFactories } from "./composition/runtime-session-services.js";
import { createSessionProviderPolicy } from "./session-provider-policy.js";

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
});
