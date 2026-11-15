import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { compressToolResult } from "../compressor/result-compressor.js";
import { runWithProviderPolicy } from "../llm/provider-policy.js";
import { EgressNotAllowedError } from "../tools/tool-egress.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { createRuntimeEgressGuard } from "./composition/runtime-egress-guard.js";
import { createSessionProviderPolicy } from "./session-provider-policy.js";
import { createSessionReadTaint, READ_TAINT_METADATA_KEY } from "./session-read-taint.js";

/**
 * Issue #33: read taint and egress together. An unconstrained session
 * that reads a file inside a constrained folder is held to that folder's
 * allowedEgress from then on, in the same turn and across turns.
 */
describe("read taint narrows egress", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function setup(allowedEgress?: string[]) {
    root = mkdtempSync(join(tmpdir(), "pc-taint-egress-"));
    const secret = join(root, "secret");
    const open = join(root, "open");
    mkdirSync(secret, { recursive: true });
    mkdirSync(open, { recursive: true });
    const config = {
      projects: { roots: [], constraints: { [secret]: { allowedProviders: ["local-llama"], ...(allowedEgress ? { allowedEgress } : {}) } } },
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
      dispatchGuard: createRuntimeEgressGuard({ effectivePolicyForSession: policy.effectivePolicyForSession, mcp: () => undefined }),
    });
    const fetched = vi.fn();
    registry.register({ name: "os.fs.read", description: "", readonly: true, run: async () => compressToolResult({ tool: "os.fs.read", status: "ok", output: "secret plan" }) });
    registry.register({
      name: "os.web.fetch",
      description: "",
      readonly: true,
      run: async (args) => {
        fetched(args.url);
        return compressToolResult({ tool: "os.web.fetch", status: "ok", output: "page" });
      },
    });
    const session = { id: "s-1", workingDir: open, metadata: {} as Record<string, unknown> };
    stored.set("s-1", session);
    const ctx = { sessionId: "s-1", workingDir: open, stepIndex: 0, signal: new AbortController().signal };
    return { secret, policy, registry, fetched, session, taint, ctx };
  }

  it("refuses os.web.fetch after the read, in the same turn and on the next one", async () => {
    const t = setup();
    await runWithProviderPolicy(t.policy.forSession(t.session), () =>
      t.taint.inTurn(t.session, async () => {
        // Unconstrained before the read: the fetch would be let through.
        expect(t.registry.refusalBeforeDispatch("os.web.fetch", { url: "https://example.com/" }, t.ctx)).toBeNull();
        await t.registry.invoke("os.fs.read", { path: join(t.secret, "plan.md") }, t.ctx);
        expect(t.registry.refusalBeforeDispatch("os.web.fetch", { url: "https://example.com/" }, t.ctx)?.summary)
          .toContain(`folder ${t.secret} is restricted: os.web.fetch would send content off this machine`);
        await expect(t.registry.invoke("os.web.fetch", { url: "https://example.com/" }, t.ctx)).rejects.toThrow(EgressNotAllowedError);
      }), { sessionId: "s-1" });
    expect(t.fetched).not.toHaveBeenCalled();
    // Persisted: the stored taint carries the folder's (empty) egress list.
    expect(t.session.metadata[READ_TAINT_METADATA_KEY]).toMatchObject({ key: t.secret, allowedEgress: [] });
    expect(t.policy.effectivePolicyForSession("s-1")?.allowsEgress("web")).toBe(false);
  });

  it("lets os.web.fetch run when the folder read allows \"web\"", async () => {
    const t = setup(["web"]);
    await runWithProviderPolicy(t.policy.forSession(t.session), () =>
      t.taint.inTurn(t.session, async () => {
        await t.registry.invoke("os.fs.read", { path: join(t.secret, "plan.md") }, t.ctx);
        expect(t.registry.refusalBeforeDispatch("os.web.fetch", { url: "https://example.com/" }, t.ctx)).toBeNull();
        await t.registry.invoke("os.web.fetch", { url: "https://example.com/" }, t.ctx);
      }), { sessionId: "s-1" });
    expect(t.fetched).toHaveBeenCalledTimes(1);
    expect(t.policy.effectivePolicyForSession("s-1")?.allowsEgress("web")).toBe(true);
    expect(t.policy.effectivePolicyForSession("s-1")?.allowsEgress("github")).toBe(false);
  });
});
