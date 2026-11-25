import { PLAIN_COMPLETE_PARTITION } from "./plain-complete.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeProviderRestriction, makeProviderPolicy, noAllowedProviderError, runWithProviderPolicy } from "../llm/provider-policy.js";
import { createRuntimeSessionFactories } from "./composition/runtime-session-services.js";
import { channelNotifyRefusal, childSessionSeed, createSessionProviderPolicy, moveSessionFolder, retrySessionSeed } from "./session-provider-policy.js";

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

    it("outside the turn's frame, sees a taint the running turn holds but has not saved yet, and a stored one a stale copy lacks", () => {
      root = mkdtempSync(join(tmpdir(), "pc-session-"));
      const project = join(root, "client");
      const home = join(root, "home");
      const config = { projects: { roots: [], constraints: { [project]: { allowedProviders: ["local-llama"] } } } };
      const stamp = { key: project, allowedProviders: ["local-llama"], allowedEgress: [], matchedDir: project, readFrom: [project] };
      const stored = new Map<string, { workingDir: string; metadata?: Record<string, unknown> }>([["s-home", { workingDir: home }]]);
      const live = new Map<string, { workingDir: string; metadata?: Record<string, unknown> }>();
      const policy = createSessionProviderPolicy({
        readConfig: () => config,
        loadSession: (id) => stored.get(id) ?? null,
        liveSession: (id) => live.get(id),
      });
      expect(policy.effectivePolicyForSession("s-home")).toBeUndefined();
      live.set("s-home", { workingDir: home, metadata: { providerReadTaint: stamp } });
      expect(policy.effectivePolicyForSession("s-home")?.allowsEgress("channels")).toBe(false);
      expect(policy.effectivePolicyForSession("btw:s-home")?.allowsEgress("serve")).toBe(false);
      expect(policy.effectivePolicyForSession("btw:s-home")?.allows("openai")).toBe(false);
      live.clear();
      stored.set("s-home", { workingDir: home, metadata: { providerReadTaint: stamp } });
      expect(policy.effectivePolicyForSession({ id: "s-home", workingDir: home })?.key).toBe(project);
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

  describe("childSessionSeed (a session a session creates: tasks.schedule newSession, tasks.cron)", () => {
    it("puts a constrained caller's task in the caller's folder, not the runtime's (serve from ~, client working_dir)", () => {
      const { project, policy } = setup();
      const home = mkdtempSync(join(tmpdir(), "pc-home-"));
      try {
        const factories = createRuntimeSessionFactories(home, { save: () => {} }, () => null);
        const callerPolicy = policy.forSessionId("s-1");
        const seed = runWithProviderPolicy(callerPolicy, () =>
          childSessionSeed(policy, { sessionId: "s-1", workingDir: join(project, "src") }), { sessionId: "s-1" });
        const fresh = factories.createSession({ ...seed, metadata: { ...seed.metadata, ephemeralTask: true } });
        expect(fresh.workingDir).toBe(join(project, "src"));
        expect(policy.forSession(fresh)?.allows("openai")).toBe(false);
        expect(policy.forSession(fresh)?.allows("local-llama")).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("carries a caller's read taint into the new session (caller folder unconstrained)", () => {
      const { project, policy } = setup();
      const home = mkdtempSync(join(tmpdir(), "pc-home-"));
      try {
        const factories = createRuntimeSessionFactories(home, { save: () => {} }, () => null);
        const tainted = makeProviderPolicy({ key: project, allowedProviders: ["local-llama"], matchedDir: project, readFrom: [project] });
        const seed = runWithProviderPolicy(tainted, () =>
          childSessionSeed(policy, { sessionId: "s-home", workingDir: home }), { sessionId: "s-home" });
        const fresh = factories.createSession(seed);
        expect(fresh.workingDir).toBe(home);
        expect(policy.forSession(fresh)?.allows("openai")).toBe(false);
        expect(policy.forSession(fresh)?.readFrom).toEqual([project]);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("fails closed for a caller it cannot resolve, and adds nothing when no constraint exists", () => {
      const { config, policy } = setup();
      const seed = childSessionSeed(policy, { sessionId: "s-gone", workingDir: tmpdir() });
      const fresh = createRuntimeSessionFactories(tmpdir(), { save: () => {} }, () => null).createSession(seed);
      expect(policy.forSession(fresh)?.allowedProviders).toEqual([]);
      config.projects.constraints = {} as never;
      expect(childSessionSeed(policy, { sessionId: "s-gone", workingDir: "/w" }).metadata).toEqual({});
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

describe("moveSessionFolder (issue #68)", () => {
  const config = {
    projects: {
      roots: [],
      constraints: {
        "/work/a": { allowedProviders: ["local-llama", "openai"], allowedEgress: ["web"] },
        "/work/b": { allowedProviders: ["local-llama"], allowedEgress: ["web", "git"] },
      },
    },
  };
  const policy = createSessionProviderPolicy({ readConfig: () => config, loadSession: () => null });

  it("keeps the folder's constraint and an existing read taint, intersected, wherever the session goes", () => {
    const tainted = {
      id: "s", workingDir: "/work/a/src",
      metadata: { providerReadTaint: { key: "/work/b", allowedProviders: ["local-llama"], allowedEgress: ["web", "git"], matchedDir: "/work/b", readFrom: ["/work/b"] } },
    };
    const moved = moveSessionFolder(policy, tainted, "/elsewhere");
    expect(moved.session.workingDir).toBe("/elsewhere");
    expect(moved.kept?.readFrom).toEqual(["/work/b"]);
    expect(moved.kept?.movedFrom).toEqual(["/work/a"]);
    const after = policy.forSession(moved.session);
    expect(after?.allowedProviders).toEqual(["local-llama"]);
    expect(after?.allowedEgress).toEqual(["web"]);
    expect(moved.policy?.key).toBe(after?.key);
  });

  it("a moved chat's refusal and status say it came from the old folder, not that it read files there", () => {
    const moved = moveSessionFolder(policy, { id: "s", workingDir: "/work/b" }, "/elsewhere").session;
    const after = policy.forSession(moved)!;
    const message = noAllowedProviderError(after, "the main model").message;
    expect(message).toContain("this chat came from /work/b, which is restricted to: local-llama");
    expect(message).not.toContain("read files");
    expect(describeProviderRestriction(after)).toMatchObject({ movedFrom: ["/work/b"], readFrom: [] });
  });

  it("a tainted chat moving inside its own constraint entry keeps its stamp unchanged (review)", () => {
    const tainted = {
      id: "s", workingDir: "/work/a/src",
      metadata: { providerReadTaint: { key: "/work/b", allowedProviders: ["local-llama"], allowedEgress: ["web", "git"], matchedDir: "/work/b", readFrom: ["/work/b"] } },
    };
    const moved = moveSessionFolder(policy, tainted, "/work/a/docs");
    expect(moved.kept).toBeUndefined();
    expect(moved.session.metadata.providerReadTaint).toEqual(tainted.metadata.providerReadTaint);
    // Moving out and back never repeats a key part.
    const out = moveSessionFolder(policy, tainted, "/elsewhere");
    const back = moveSessionFolder(policy, out.session, "/work/a/x");
    const key = (back.session.metadata.providerReadTaint as { key: string }).key;
    expect(new Set(key.split(" + ")).size).toBe(key.split(" + ").length);
    expect(policy.forSession(back.session)?.key.split(" + ").sort()).toEqual(["/work/a", "/work/b"]);
  });

  it("adds nothing inside the same constraint entry, for an unrestricted session, or with no constraint configured", () => {
    const inside = moveSessionFolder(policy, { id: "s", workingDir: "/work/a/src" }, "/work/a/docs");
    expect(inside.kept).toBeUndefined();
    expect(inside.session).not.toHaveProperty("metadata");
    const open = moveSessionFolder(policy, { id: "s", workingDir: "/free" }, "/work/b");
    expect(open.kept).toBeUndefined();
    expect(open.policy?.key).toBe("/work/b");
    const none = createSessionProviderPolicy({ readConfig: () => ({ projects: { roots: [], constraints: {} } }), loadSession: () => null });
    expect(moveSessionFolder(none, { id: "s", workingDir: "/work/a" }, "/free").kept).toBeUndefined();
  });
});

describe("a stored stamp follows its constraint entries live (issue #68 review)", () => {
  it("a tightened entry reaches a moved chat; a loosened or removed one leaves the snapshot holding", () => {
    const config: { projects: { roots: never[]; constraints: Record<string, { allowedProviders: string[]; allowedEgress?: string[] }> } } = {
      projects: { roots: [], constraints: { "/work/a": { allowedProviders: ["local-llama", "openai"], allowedEgress: ["web"] }, "/work/z": { allowedProviders: [] } } },
    };
    const policy = createSessionProviderPolicy({ readConfig: () => config, loadSession: () => null });
    const moved = moveSessionFolder(policy, { id: "s", workingDir: "/work/a" }, "/free").session;
    expect(policy.forSession(moved)?.allows("openai")).toBe(true);
    // Tightened: the live entry narrows the snapshot.
    config.projects.constraints["/work/a"] = { allowedProviders: ["local-llama"], allowedEgress: [] };
    expect(policy.forSession(moved)?.allows("openai")).toBe(false);
    expect(policy.forSession(moved)?.allowsEgress("web")).toBe(false);
    expect(policy.forSession(moved)?.key).toBe("/work/a");
    // Loosened: the snapshot still holds (stricter wins).
    config.projects.constraints["/work/a"] = { allowedProviders: ["local-llama", "openai", "anthropic"], allowedEgress: ["web", "http"] };
    expect(policy.forSession(moved)?.allows("anthropic")).toBe(false);
    expect(policy.forSession(moved)?.allows("openai")).toBe(true);
    // Removed (other entries remain): the snapshot still holds.
    delete config.projects.constraints["/work/a"];
    expect(policy.forSession(moved)?.allows("openai")).toBe(true);
    expect(policy.forSession(moved)?.allows("anthropic")).toBe(false);
  });
});

describe("retrySessionSeed (issue #68)", () => {
  const config = { projects: { roots: [], constraints: { "/work/a": { allowedProviders: ["local-llama"] } } } };
  const policy = createSessionProviderPolicy({ readConfig: () => config, loadSession: () => null });

  it("reads the original chat's live view: a taint its running turn has not saved yet is carried", () => {
    const taint = { key: "/work/a", allowedProviders: ["local-llama"], allowedEgress: [], matchedDir: "/work/a", readFrom: ["/work/a"] };
    const live = createSessionProviderPolicy({
      readConfig: () => config,
      loadSession: (id) => (id === "s-run" ? { workingDir: "/free" } : null),
      liveSession: (id) => (id === "s-run" ? { workingDir: "/free", metadata: { providerReadTaint: taint } } : undefined),
    });
    const seed = retrySessionSeed(live, { kind: "session", session: { id: "s-run", workingDir: "/free" } }, "/free");
    expect(seed).toMatchObject({ ok: true, restricted: true, metadata: { providerReadTaint: { key: "/work/a", allowedProviders: ["local-llama"] } } });
  });

  it("carries the original chat's restriction, refuses a gone chat, and adds nothing otherwise", () => {
    const kept = retrySessionSeed(policy, { kind: "session", session: { id: "s", workingDir: "/work/a" } }, "/free");
    expect(kept).toMatchObject({ ok: true, restricted: true, metadata: { providerReadTaint: { key: "/work/a", allowedProviders: ["local-llama"] } } });
    expect(retrySessionSeed(policy, { kind: "session", session: { id: "s", workingDir: "/work/a" } }, "/work/a")).toEqual({ ok: true, metadata: {}, restricted: false });
    expect(retrySessionSeed(policy, { kind: "missing" }, "/free").ok).toBe(false);
    expect(retrySessionSeed(policy, { kind: "none" }, "/free")).toEqual({ ok: true, metadata: {}, restricted: false });
    const none = createSessionProviderPolicy({ readConfig: () => ({ projects: { roots: [], constraints: {} } }), loadSession: () => null });
    expect(retrySessionSeed(none, { kind: "missing" }, "/free").ok).toBe(true);
  });
});

describe("the plain completion partition (POST /api/complete)", () => {
  it("is refused everything while any constraint exists: it names no session (fail closed)", () => {
    const config = { projects: { roots: [], constraints: { "/elsewhere/client": { allowedProviders: ["local-llama"] } } } };
    const policy = createSessionProviderPolicy({ readConfig: () => config, loadSession: () => null });
    const plain = policy.forSessionId(PLAIN_COMPLETE_PARTITION);
    expect(plain?.allowedProviders).toEqual([]);
    expect(plain?.allows("local-llama")).toBe(false);
    const open = createSessionProviderPolicy({ readConfig: () => ({ projects: { roots: [], constraints: {} } }), loadSession: () => null });
    expect(open.forSessionId(PLAIN_COMPLETE_PARTITION)).toBeUndefined();
  });
});

