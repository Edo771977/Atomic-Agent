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
      lookup: async () => [{ address: "93.184.215.14", family: 4 }], request,
    })).toMatchObject({ status: "unverified" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("reports an approved 404 from a local fixture server", async () => {
    const { createServer } = await import("node:http");
    const { authorizeVerifyBatch } = await import("./verify-authorization.js");
    const { probeResearchLink } = await import("./research-links.js");
    const server = createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("test listener unavailable");
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
          request: async (_url, _ip, method, signal) => {
            const response = await fetch(`http://127.0.0.1:${address.port}/missing`, { method, signal });
            return { status: response.status };
          },
        }),
      });
      expect(request).toHaveBeenCalledWith(expect.objectContaining({ category: "http" }), expect.anything());
      expect(result).toMatchObject({ artifactStatus: "fail", stdoutTail: expect.stringContaining(`[1] ${url}`) });
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()); });
    }
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
  }, spec => guard(spec.kind === "research" && spec.network === true ? "os.http.request" : "verify.run", spec, { sessionId: "restricted" }));
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
