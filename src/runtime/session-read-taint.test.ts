import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertProviderAllowed,
  currentProviderPolicy,
  makeProviderPolicy,
  runWithProviderPolicy,
} from "../llm/provider-policy.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { createSessionProviderPolicy } from "./session-provider-policy.js";
import { createSessionReadTaint, READ_TAINT_METADATA_KEY } from "./session-read-taint.js";

/** Issue #33 group C: reading inside a constrained folder taints the session. */
describe("session read taint", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), "pc-read-taint-"));
    const secret = join(root, "secret");
    const finance = join(root, "finance");
    const open = join(root, "open");
    for (const dir of [secret, finance, open]) mkdirSync(dir, { recursive: true });
    const config = {
      projects: {
        roots: [],
        constraints: {
          [secret]: { allowedProviders: ["local-llama", "ollama"] },
          [finance]: { allowedProviders: ["local-llama"] },
        },
      },
    };
    const stored = new Map<string, { workingDir: string; metadata?: Record<string, unknown> }>();
    const taint = createSessionReadTaint({
      readConfig: () => config,
      patchStoredSession: (id, patch) => {
        const s = stored.get(id);
        if (s) s.metadata = patch(s.metadata ?? {});
      },
    });
    const policy = createSessionProviderPolicy({ readConfig: () => config, loadSession: (id) => stored.get(id) ?? null });
    const registry = new ToolRegistry({
      knownSecrets: () => [],
      onDispatch: (name, args, ctx) => { taint.noteDispatch(name, args, ctx); },
    });
    const calls: string[] = [];
    registry.register({
      name: "os.fs.read",
      description: "",
      readonly: true,
      run: async (args) => {
        // What a model-calling read (vision.describe) would hit inside the tool.
        calls.push(currentProviderPolicy()?.key ?? "(none)");
        return { tool: "os.fs.read", status: "ok", output: String(args.path), summary: "", details: {} } as never;
      },
    });
    return { secret, finance, open, config, stored, taint, policy, registry, calls };
  }

  const ctx = (sessionId: string, workingDir: string) => ({
    sessionId,
    workingDir,
    stepIndex: 0,
    signal: new AbortController().signal,
  });

  it("an unconstrained session that reads a constrained file is restricted from then on, and keeps it on resume", async () => {
    const t = setup();
    const session = { id: "s-1", workingDir: t.open, metadata: {} as Record<string, unknown> };
    t.stored.set("s-1", session);
    await runWithProviderPolicy(t.policy.forSession(session), () =>
      t.taint.inTurn(session, async () => {
        expect(() => assertProviderAllowed("openai", { constraintsActive: () => true })).not.toThrow();
        await t.registry.invoke("os.fs.read", { path: join(t.secret, "plan.md") }, ctx("s-1", t.open));
        // The read itself already ran under the taint.
        expect(t.calls).toEqual([t.secret]);
        expect(() => assertProviderAllowed("openai", { constraintsActive: () => true })).toThrow(
          `this session read files from ${t.secret}, which is restricted to: local-llama, ollama`,
        );
        expect(() => assertProviderAllowed("local-llama", { constraintsActive: () => true })).not.toThrow();
      }), { role: "the main model" });
    expect(session.metadata[READ_TAINT_METADATA_KEY]).toMatchObject({ key: t.secret, readFrom: [t.secret] });
    // The next turn, a side call by id, and /resume all see it.
    expect(t.policy.forSession(session)?.allows("openai")).toBe(false);
    expect(t.policy.forSessionId("compaction:s-1")?.allows("ollama")).toBe(true);
  });

  it("several folders read: the intersection of their lists", async () => {
    const t = setup();
    const session = { id: "s-2", workingDir: t.open, metadata: {} as Record<string, unknown> };
    await runWithProviderPolicy(undefined, () =>
      t.taint.inTurn(session, async () => {
        await t.registry.invoke("os.fs.read", { path: join(t.secret, "a.md") }, ctx("s-2", t.open));
        await t.registry.invoke("os.fs.read", { path: join(t.finance, "b.md") }, ctx("s-2", t.open));
        expect(currentProviderPolicy()?.allowedProviders).toEqual(["local-llama"]);
        expect(currentProviderPolicy()?.readFrom).toEqual([t.secret, t.finance]);
      }));
    expect(t.policy.forSession(session)?.allowedProviders).toEqual(["local-llama"]);
  });

  it("reads outside every constrained folder, and a folder's own files, add nothing", async () => {
    const t = setup();
    const open = { id: "s-3", workingDir: t.open, metadata: {} as Record<string, unknown> };
    await runWithProviderPolicy(undefined, () =>
      t.taint.inTurn(open, async () => {
        await t.registry.invoke("os.fs.read", { path: join(t.open, "x.md") }, ctx("s-3", t.open));
        expect(currentProviderPolicy()).toBeUndefined();
      }));
    expect(open.metadata[READ_TAINT_METADATA_KEY]).toBeUndefined();

    const inside = { id: "s-4", workingDir: t.secret, metadata: {} as Record<string, unknown> };
    await runWithProviderPolicy(t.policy.forSession(inside), () =>
      t.taint.inTurn(inside, async () => {
        await t.registry.invoke("os.fs.read", { path: join(t.secret, "y.md") }, ctx("s-4", t.secret));
        expect(currentProviderPolicy()?.readFrom).toBeUndefined();
      }));
    expect(inside.metadata[READ_TAINT_METADATA_KEY]).toBeUndefined();
  });

  it("a shell command naming a constrained path taints too", () => {
    const t = setup();
    const session = { id: "s-5", workingDir: t.open, metadata: {} as Record<string, unknown> };
    t.stored.set("s-5", session);
    const applied = runWithProviderPolicy(undefined, () =>
      t.taint.noteDispatch("os.shell.run", { cmd: "cat", args: [join(t.finance, "q3.csv")] }, ctx("s-5", t.open)));
    expect(applied?.allowedProviders).toEqual(["local-llama"]);
    // No live turn: the stored session is patched.
    expect(session.metadata[READ_TAINT_METADATA_KEY]).toMatchObject({ key: t.finance });
  });

  it("a fusion worker's read taints its orchestrator's running turn", async () => {
    const t = setup();
    const parent = { id: "p-1", workingDir: t.open, metadata: {} as Record<string, unknown> };
    const worker = {
      id: "w-1",
      workingDir: t.open,
      metadata: { fusionWorker: { parentSessionId: "p-1", taskId: "t1", providerPolicy: null } } as Record<string, unknown>,
    };
    await runWithProviderPolicy(undefined, () =>
      t.taint.inTurn(parent, async () => {
        await runWithProviderPolicy(undefined, () =>
          t.taint.inTurn(worker, async () => {
            await t.registry.invoke("os.fs.read", { path: join(t.finance, "q.md") }, ctx("w-1", t.open));
          }));
        expect(currentProviderPolicy()?.key).toBe(t.finance);
      }));
    expect(parent.metadata[READ_TAINT_METADATA_KEY]).toMatchObject({ key: t.finance });
  });

  it("does nothing while no constraint is configured", () => {
    const t = setup();
    t.config.projects.constraints = {};
    const applied = runWithProviderPolicy(undefined, () =>
      t.taint.noteDispatch("os.fs.read", { path: join(t.secret, "a.md") }, ctx("s-6", t.open)));
    expect(applied).toBeUndefined();
    expect(makeProviderPolicy({ key: "k", allowedProviders: [], matchedDir: "" }).readFrom).toBeUndefined();
  });
});
