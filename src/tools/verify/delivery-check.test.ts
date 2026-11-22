import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runVerify } from "./run-verify.js";
import { parseVerifyRunArgs } from "./verify-run-args.js";

let workingDir: string;
beforeEach(async () => {
  workingDir = await mkdtemp(join(tmpdir(), "verify-delivery-"));
  await mkdir(join(workingDir, "delivery"));
  await writeFile(join(workingDir, "delivery", "report.txt"), "contents");
});
afterEach(async () => rm(workingDir, { recursive: true, force: true }));

describe("files", () => {
  const path = join("delivery", "report.txt");
  it("checks presence and type", async () => {
    expect(await runVerify({ kind: "files", expected: [path] }, { workingDir })).toMatchObject({ artifactStatus: "pass" });
    for (const missing of ["missing.txt", "delivery"]) {
      const result = await runVerify({ kind: "files", expected: [`file:${missing}`] }, { workingDir });
      expect(result.artifactStatus).toBe("fail");
      expect(result.stdoutTail).toContain(missing);
    }
  });
  it.each(["../escape", "/absolute", "C:\\absolute"])("rejects %s at parsing", path => {
    expect(() => parseVerifyRunArgs({ kind: "files", expected: [path] })).toThrow(/relative/);
  });
  it("needs known changes to confirm containment", async () => {
    const spec = { kind: "files", expected: [path], within: "delivery" };
    expect(await runVerify(spec, { workingDir, changedPaths: [path] })).toMatchObject({ artifactStatus: "pass" });
    expect(await runVerify(spec, { workingDir, changedPaths: ["outside.txt"] })).toMatchObject({
      artifactStatus: "fail", stdoutTail: expect.stringContaining("outside.txt"),
    });
    expect(await runVerify(spec, { workingDir })).toMatchObject({
      artifactStatus: "uncheckable", error: expect.stringContaining("unknown"),
    });
  });
});

describe("research", () => {
  const verify = async (text: string, options: Record<string, unknown> = {}) => {
    await writeFile(join(workingDir, "research.md"), text);
    return runVerify({ kind: "research", path: "research.md", ...options }, { workingDir });
  };
  it("fails on a citation without a source", async () => {
    expect(await verify("A statement [1].")).toMatchObject({ artifactStatus: "fail", stdoutTail: expect.stringContaining("[1]") });
  });
  it("warns about missing dates and can require them", async () => {
    const text = "A statement [^1].\n\n[^1]: Field notes";
    expect(await verify(text)).toMatchObject({ artifactStatus: "pass", stdoutTail: expect.stringContaining("no date") });
    expect(await verify(text, { requireDates: true })).toMatchObject({ artifactStatus: "fail" });
  });
  it("lists URLs as unverified without network authorization", async () => {
    const result = await verify("A statement [1].\n\n## Sources\n[1] Field notes (2025) https://example.org/notes", { network: true });
    expect(result).toMatchObject({ ok: false, artifactStatus: "uncheckable", stdoutTail: expect.stringContaining("https://example.org/notes") });
    expect(result.stdoutTail).toContain("unverified");
  });
});

describe("research link verification", () => {
  it.each(["127.0.0.1", "192.168.1.2"])("does not follow redirects to %s", async host => {
    const { probeResearchLink } = await import("./research-links.js");
    const request = vi.fn(async () => ({ status: 302, location: `http://${host}/secret` }));
    expect(await probeResearchLink("https://example.org/notes", AbortSignal.timeout(1000), {
      lookup: async () => [{ address: "93.184.215.14", family: 4 }], request, env: {},
    })).toMatchObject({ status: "unverified" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("reports an approved 404 from an inert transport fixture", async () => {
    const { authorizeVerifyBatch } = await import("./verify-authorization.js");
    const { probeResearchLink } = await import("./research-links.js");
    const signal = AbortSignal.timeout(10_000);
    const request = vi.fn(async () => ({ approved: true }));
    const url = "http://example.org/missing";
    await writeFile(join(workingDir, "research.md"), `Claim [1].\n\n## Sources\n[1] Notes (2025) ${url}`);
    const [spec] = await authorizeVerifyBatch([{ kind: "research", path: "research.md", network: true }], {
      approvals: { request } as never, approvalRequired: true,
    }, { workingDir, signal, stepIndex: 0, sessionId: "research" });
    const result = await runVerify(spec!, {
      workingDir, signal, researchProbe: (link, abort) => probeResearchLink(link, abort, {
        lookup: async () => [{ address: "93.184.215.14", family: 4 }],
        request: async () => ({ status: 404 }),
        env: {},
      }),
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ category: "http" }), expect.anything());
    expect(result).toMatchObject({ artifactStatus: "fail", stdoutTail: expect.stringContaining(`[1] ${url}`) });
  });
  it("does not probe an oversized URL list", async () => {
    const { checkResearchLinks } = await import("./research-links.js");
    const probe = vi.fn();
    const links = Array.from({ length: 33 }, (_, i) => ({ url: `https://example.org/${i}`, citations: "[1]" }));
    expect(await checkResearchLinks({ status: "pass", detail: "sources", links }, probe)).toMatchObject({ status: "uncheckable" });
    expect(probe).not.toHaveBeenCalled();
  });
});

it("keeps restricted Fusion research links and the linked criterion unverified", async () => {
  const { withContractCheckEgress } = await import("../fusion/contract-check-egress.js");
  const { runContractChecks } = await import("../fusion/contract-checks.js");
  const { criteriaFactsFor } = await import("../fusion/criteria-facts.js");
  const { runChecks } = await import("./run-verify.js");
  const { authorizeVerifyBatch } = await import("./verify-authorization.js");
  const { createEgressGuard } = await import("../tool-egress.js");
  const { makeProviderPolicy } = await import("../../llm/provider-policy.js");
  const policy = makeProviderPolicy({ key: workingDir, allowedProviders: ["local-llama"], matchedDir: workingDir });
  const guard = createEgressGuard({ policyForSession: () => policy });
  const probe = vi.fn();
  const request = vi.fn(async () => ({ approved: true }));
  const runner = withContractCheckEgress(async (specs, ctx) => {
    const approved = await authorizeVerifyBatch(specs, { approvals: { request } as never, approvalRequired: true }, {
      ...ctx, stepIndex: 0, sessionId: "restricted",
    });
    return runChecks(approved, { ...ctx, researchProbe: probe });
  }, spec => guard("verify.run", spec, { sessionId: "restricted" }));
  const signal = AbortSignal.timeout(10_000);
  await writeFile(join(workingDir, "research.md"), "Claim [1].\n\n## Sources\n[1] Notes (2025) https://example.org/notes");
  const check = { kind: "research", path: "research.md", network: true, criteria: ["sources"] };
  const result = await runContractChecks([check], runner, { workingDir, signal });
  expect(result.outcomes).toMatchObject([{ ok: false, artifactStatus: "uncheckable", criteria: ["sources"], detail: expect.stringContaining("folder") }]);
  expect(criteriaFactsFor([{ id: "sources", text: "Sources are reachable", checkIndexes: [0] }], { checks: [check] }, result.outcomes, undefined)).toMatchObject([{ state: "unverified" }]);
  expect(probe).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ category: "shell" }), expect.anything());
});

it.each([["reference.md", "pass"], ["with-url.md", "uncheckable"]] as const)("runs the local research fixture %s", async (path, artifactStatus) => {
  const { readFile } = await import("node:fs/promises");
  const { buildVerifyRunTool } = await import("./verify-run.js");
  await writeFile(join(workingDir, path), await readFile(new URL(`../../../docs/testing/fixtures/research/${path}`, import.meta.url)));
  const request = vi.fn(async () => ({ approved: true }));
  const tool = buildVerifyRunTool({ approvals: { request } as never, approvalRequired: true, config: {} as never });
  const result = await tool.run({ kind: "research", path, requireDates: true }, {
    workingDir, sessionId: "fixture", stepIndex: 0, signal: AbortSignal.timeout(10_000),
  });
  expect(result.details).toMatchObject({ artifactStatus });
  expect(request).toHaveBeenCalledTimes(1);
});

it("checks build outputs on the integrity-guarded source", async () => {
  await mkdir(join(workingDir, "dist"));
  await writeFile(join(workingDir, "dist", "app.js"), "");
  const complete = vi.fn(async () => {});
  const begin = vi.fn(async () => complete);
  expect(await runVerify({ kind: "files", expected: [join("dist", "app.js")] }, {
    workingDir, inputIntegrity: { begin },
    workspace: async () => ({ dir: workingDir, isolated: false, cleanup: async () => {} }),
  })).toMatchObject({ artifactStatus: "pass" });
  expect(begin).toHaveBeenCalledWith(workingDir, expect.anything());
  expect(complete).toHaveBeenCalledOnce();
});

it.each([
  ["Sources\n[1] Publication (2025)", "uncheckable"],
  ["Sources\n[1] Publication (2025)\n\nLater claim [1].", "pass"],
  ["Claim [1].\n**References**\n[1] Publication (2025)", "pass"],
  ["Claim [1].\nBibliography\n[1] Publication pp. 1999", "fail"],
  ["Claim [1].\nBibliografia\n[1] ISBN 978-1999-1234", "fail"],
  ["Claim [1]. a[2] and `x[3]`.\n[4]: https://example.test\nSources\n[1] Publication (2025)", "pass"],
])("evaluates local citation syntax: %s", async (text, status) => {
  const { evaluateResearch } = await import("./research-check.js");
  expect(await evaluateResearch(Buffer.from(text), ".txt", true)).toMatchObject({ status });
});

it("preserves balanced URL punctuation and leaves ambiguous links unverified", async () => {
  const { evaluateResearch } = await import("./research-check.js");
  const { checkResearchLinks } = await import("./research-links.js");
  const out = await evaluateResearch(Buffer.from("Claim [1].\nSources\n[1] Notes (2025) **https://example.test/Foo_(bar)**, https://example.test/broken(open"), ".md", true);
  const probe = vi.fn(async () => ({ status: "verified" as const, reason: "fixture" }));
  expect(await checkResearchLinks(out, probe)).toMatchObject({
    status: "uncheckable", researchLinks: [
      { url: "https://example.test/Foo_(bar)", status: "verified" },
      { url: "https://example.test/broken(open", status: "unverified" },
    ],
  });
  expect(probe).toHaveBeenCalledTimes(1);
});

it("honors proxy-only routing without invoking DNS or transport", async () => {
  const { probeResearchLink } = await import("./research-links.js");
  const lookup = vi.fn(async () => { throw Object.assign(new Error("stub"), { code: "ENOTFOUND" }); });
  const request = vi.fn();
  expect(await probeResearchLink("https://example.test/", AbortSignal.timeout(1000), {
    lookup, request, env: { HTTPS_PROXY: "http://proxy.example.test:3128" },
  })).toMatchObject({ status: "unverified", reason: expect.stringContaining("proxy") });
  expect(lookup).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it("does not treat an ambiguous resolver ENOTFOUND as authoritative", async () => {
  const { probeResearchLink } = await import("./research-links.js");
  const lookup = vi.fn(async () => { throw Object.assign(new Error("stub"), { code: "ENOTFOUND" }); });
  expect(await probeResearchLink("https://example.test/", AbortSignal.timeout(1000), { lookup, env: {} })).toMatchObject({ status: "unverified" });
});

it("retries pinned addresses and confirms HEAD 404 with ranged GET", async () => {
  const { probeResearchLink } = await import("./research-links.js");
  const request = vi.fn(async (_url: URL, ip: string, method: string) => {
    if (ip === "93.184.215.14") throw new Error("transport");
    return { status: method === "HEAD" ? 404 : 206 };
  });
  const lookup = async () => [{ address: "93.184.215.14", family: 4 }, { address: "93.184.215.15", family: 4 }];
  expect(await probeResearchLink("https://example.test/", AbortSignal.timeout(1000), { lookup, request, env: {} })).toMatchObject({ status: "verified" });
  expect(request.mock.calls.map(([, ip, method]) => [ip, method])).toEqual([
    ["93.184.215.14", "HEAD"], ["93.184.215.15", "HEAD"], ["93.184.215.15", "GET"],
  ]);
});

it("resolves and pins each redirect host with at most three redirects", async () => {
  const { probeResearchLink } = await import("./research-links.js");
  const lookup = vi.fn(async (host: string) => [{ address: host === "doi.example.test" ? "93.184.215.14" : "93.184.215.15", family: 4 }]);
  const request = vi.fn(async (url: URL, _ip: string) => url.hostname === "doi.example.test"
    ? { status: 302, location: "https://publisher.example.test/article" } : { status: 200 });
  expect(await probeResearchLink("https://doi.example.test/item", AbortSignal.timeout(1000), { lookup, request, env: {} })).toMatchObject({ status: "verified" });
  expect(request.mock.calls.map(([url, ip]) => [url.hostname, ip])).toEqual([
    ["doi.example.test", "93.184.215.14"], ["publisher.example.test", "93.184.215.15"],
  ]);
  const loop = vi.fn(async () => ({ status: 302, location: "/loop" }));
  expect(await probeResearchLink("https://doi.example.test/item", AbortSignal.timeout(1000), { lookup, request: loop, env: {} })).toMatchObject({ status: "unverified" });
  expect(loop).toHaveBeenCalledTimes(4);
});

it.each([
  ["Claim [2].\nSources\n[1] Notes (2025) https://example.test/", undefined],
  ["Claim [1].\nSources\n[1] Notes (2025) https://example.test/?q=fixture-secret-value", "fixture-secret-value"],
])("never asks for network approval on local failure or a hidden URL", async (text, secret) => {
  const { authorizeVerifyBatch } = await import("./verify-authorization.js");
  const signal = AbortSignal.timeout(10_000);
  const request = vi.fn(async () => ({ approved: true }));
  await writeFile(join(workingDir, "research.md"), text);
  const [spec] = await authorizeVerifyBatch([{ kind: "research", path: "research.md", network: true }], {
    approvals: { request } as never, approvalRequired: true,
    ...(secret === undefined ? {} : { knownSecrets: [{ name: "fixture", value: secret }] }),
  }, { workingDir, signal, stepIndex: 0, sessionId: "research" });
  const researchProbe = vi.fn(async () => ({ status: "verified" as const, reason: "fixture" }));
  expect(await runVerify(spec!, { workingDir, signal, researchProbe })).toMatchObject({ artifactStatus: secret ? "uncheckable" : "fail" });
  expect(request).toHaveBeenCalledTimes(1);
  expect(researchProbe).not.toHaveBeenCalled();
});

it("limits concurrent non-cancellable resolver work", async () => {
  const { probeResearchLink } = await import("./research-links.js");
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const lookup = vi.fn(async () => { await pending; return [{ address: "93.184.215.14", family: 4 }]; });
  const request = vi.fn(async () => ({ status: 200 }));
  const probes = Array.from({ length: 6 }, (_, i) => probeResearchLink("https://example.test/" + i,
    AbortSignal.timeout(1000), { lookup, request, env: {} }));
  try { expect(lookup).toHaveBeenCalledTimes(4); } finally { release(); await Promise.all(probes); }
});

it("attaches only network approval to the final research execution", async () => {
  const { createContractCheckHold } = await import("../fusion/contract-check-hold.js");
  const { runChecks } = await import("./run-verify.js");
  const signal = AbortSignal.timeout(10000);
  const request = vi.fn(async (_prompt: object) => ({ approved: true }));
  const checkReadTargets = vi.fn(async () => null);
  await writeFile(join(workingDir, "research.md"), "Claim [1].\nSources\n[1] Notes (2025) https://example.test/");
  const spec = { kind: "research", path: "research.md", network: true };
  const hold = createContractCheckHold({
    runner: (specs, ctx) => runChecks(specs, { ...ctx, researchProbe: async () => ({ status: "verified", reason: "fixture" }) }),
    approvals: { request } as never, approvalRequired: true, sessionId: "research",
    workingDir, signal, tool: "fusion.delegate", checks: [spec], checkReadTargets,
  });
  expect(await hold.decide(signal)).toBeUndefined();
  expect(await hold.finalRunner!([spec], { workingDir, signal })).toMatchObject({ ok: true });
  expect(request.mock.calls.map(([prompt]) => prompt)).toEqual([
    expect.objectContaining({ category: "shell" }), expect.objectContaining({ category: "http" }),
  ]);
  expect(checkReadTargets).toHaveBeenCalledTimes(1);
});

it.each(["ui", "document", "spreadsheet", "files", "research"])("reports uncheckable %s consistently in Fusion", async kind => {
  const { runContractChecks } = await import("../fusion/contract-checks.js");
  const { criteriaFactsFor } = await import("../fusion/criteria-facts.js");
  const check = { kind, criteria: ["evidence"] };
  const result = await runContractChecks([check], async () => ({
    ok: false, results: [{ ok: false, artifactStatus: "uncheckable", error: "fixture" }],
  }), { workingDir, signal: AbortSignal.timeout(1000) });
  expect(criteriaFactsFor([{ id: "evidence", text: "", checkIndexes: [0] }], { checks: [check] }, result.outcomes, undefined)).toMatchObject([{ state: "unverified" }]);
});

it.each(["kind", "type"])("classifies research HTTP egress via %s", async field => {
  const { egressTargetOf } = await import("../tool-egress.js");
  expect(egressTargetOf("verify.run", { [field]: "research", network: true })).toEqual({ cls: "http" });
  expect(egressTargetOf("verify.run", { [field]: "research", network: false })).toBeNull();
});

it.each(["64:ff9b::7f00:1", "2002:7f00:1::1"])("rejects IPv6 transition range %s in the shared guard", async ip => {
  const { isBlockedIp } = await import("../os/web/web-fetch-ssrf-guard.js");
  expect(isBlockedIp(ip)).toBe(true);
});

it("lists restricted URLs through the registered verify.run tool", async () => {
  const { ToolRegistry } = await import("../tool-registry.js");
  const { registerVerifyTools } = await import("./index.js");
  const { makeProviderPolicy } = await import("../../llm/provider-policy.js");
  const { createEgressGuard } = await import("../tool-egress.js");
  const policy = makeProviderPolicy({ key: workingDir, allowedProviders: ["local-llama"], matchedDir: workingDir });
  const guard = createEgressGuard({ policyForSession: () => policy });
  const dispatchGuard = vi.fn(guard);
  const registry = new ToolRegistry({ dispatchGuard });
  const request = vi.fn(async () => ({ approved: true }));
  registerVerifyTools(registry, { approvals: { request } as never, approvalRequired: true, config: {} as never });
  await writeFile(join(workingDir, "research.md"), "Claim [1].\nSources\n[1] Notes (2025) https://example.test/");
  const spec = { kind: "research", path: "research.md", network: true };
  const ctx = { workingDir, signal: AbortSignal.timeout(10000), stepIndex: 0, sessionId: "restricted" };
  expect(registry.refusalBeforeDispatch("verify.run", spec, ctx)).toBeNull();
  const result = await registry.invoke("verify.run", spec, ctx);
  expect(result.details).toMatchObject({ artifactStatus: "uncheckable", researchLinks: [
    { status: "unverified", reason: expect.stringContaining("verify.run") },
  ] });
  expect(request).toHaveBeenCalledTimes(1);
  expect(dispatchGuard).toHaveBeenCalledWith("verify.run", expect.objectContaining({ network: true }), expect.anything());
});
