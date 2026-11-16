import { describe, expect, it, vi } from "vitest";

import { makeProviderPolicy } from "../../llm/provider-policy.js";
import { createEgressGuard } from "../tool-egress.js";
import { withContractCheckEgress } from "./contract-check-egress.js";
import type { ContractCheckRunner } from "./contract-checks.js";

const signal = new AbortController().signal;
const policy = makeProviderPolicy({ key: "/work/secret", allowedProviders: ["local-llama"], matchedDir: "/work/secret" });
const guard = createEgressGuard({ policyForSession: (id) => (id === "constrained" ? policy : undefined) });
const refuse = (sessionId: string) => (spec: Record<string, unknown>) => guard("verify.run", spec, { sessionId });

function runner() {
  return Object.assign(
    vi.fn<ContractCheckRunner>(async (specs) => ({ ok: true, results: specs.map((s) => ({ ok: true, summary: `ran ${String(s.cmd ?? s.path)}` })) })),
    { supportsInputIntegrity: true as const },
  );
}

describe("contract checks under the folder's egress rule (issue #40)", () => {
  it("refuses a page check in a constrained folder without the browser class, as a red result with the egress message, and runs the rest", async () => {
    const inner = runner();
    const wrapped = withContractCheckEgress(inner, refuse("constrained"))!;
    const out = await wrapped([
      { kind: "command", cmd: "node", args: ["--check", "a.js"] },
      { kind: "page", path: "index.html", checks: ["no errors"] },
      { kind: "command", cmd: "node", args: ["--check", "b.js"] },
    ], { workingDir: "/work/secret", signal });
    expect(inner).toHaveBeenCalledOnce();
    expect(inner.mock.calls[0]![0]).toEqual([
      { kind: "command", cmd: "node", args: ["--check", "a.js"] },
      { kind: "command", cmd: "node", args: ["--check", "b.js"] },
    ]);
    expect(out.ok).toBe(false);
    expect(out.results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(out.results[1]!.error).toContain('add "browser" to projects.constraints');
    expect(out.results[1]!.summary).toContain("REFUSED");
    expect(out.results[2]!.summary).toBe("ran node");
    expect(wrapped.supportsInputIntegrity).toBe(true);
  });

  it("refuses a networked command (best effort, the dispatch rule) and the `type`/`command` spellings too", async () => {
    const inner = runner();
    const wrapped = withContractCheckEgress(inner, refuse("constrained"))!;
    const out = await wrapped([
      { kind: "command", cmd: "curl", args: ["https://example.test"] },
      { type: "page", url: "http://127.0.0.1:8080/" },
      { kind: "command", command: "curl https://example.test" },
    ], { workingDir: "/work/secret", signal });
    expect(inner).not.toHaveBeenCalled();
    expect(out.ok).toBe(false);
    expect(out.results.map((r) => r.ok)).toEqual([false, false, false]);
    expect(out.results[0]!.error).toContain("runs curl");
    expect(out.results[1]!.error).toContain('"browser"');
    expect(out.results[2]!.error).toContain("runs curl");
  });

  it("keeps the per-spec task list aligned with the specs it lets through", async () => {
    const inner = runner();
    const wrapped = withContractCheckEgress(inner, refuse("constrained"))!;
    await wrapped([
      { kind: "page", path: "index.html" },
      { kind: "command", cmd: "node", args: ["a.js"] },
    ], { workingDir: "/work/secret", signal, checkTasks: ["t-page", "t-cmd"], run: { runId: "fr-1", sessionId: "s" } });
    expect(inner.mock.calls[0]![1].checkTasks).toEqual(["t-cmd"]);
    expect(inner.mock.calls[0]![1].run).toEqual({ runId: "fr-1", sessionId: "s" });
  });

  it("leaves an unconstrained session's checks alone", async () => {
    const inner = runner();
    const wrapped = withContractCheckEgress(inner, refuse("open"))!;
    const out = await wrapped([{ kind: "page", path: "index.html" }], { workingDir: "/w", signal });
    expect(inner).toHaveBeenCalledOnce();
    expect(out).toEqual({ ok: true, results: [{ ok: true, summary: "ran index.html" }] });
  });

  it("allows a page check once the folder lists the browser class", async () => {
    const open = makeProviderPolicy({ key: "/w", allowedProviders: ["local-llama"], allowedEgress: ["browser"], matchedDir: "/w" });
    const allowGuard = createEgressGuard({ policyForSession: () => open });
    const inner = runner();
    const wrapped = withContractCheckEgress(inner, (spec) => allowGuard("verify.run", spec, { sessionId: "s" }))!;
    expect((await wrapped([{ kind: "page", path: "index.html" }], { workingDir: "/w", signal })).ok).toBe(true);
  });

  it("is absent when there is no runner, and a pass-through when there is no rule", () => {
    expect(withContractCheckEgress(undefined, refuse("constrained"))).toBeUndefined();
    const inner = runner();
    expect(withContractCheckEgress(inner, undefined)).toBe(inner);
  });
});
