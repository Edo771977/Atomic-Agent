import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { makeProviderPolicy, type ProviderPolicy } from "../config/project-constraint-match.js";
import { createWriteOutGuard, WRITE_OUT_NOT_ALLOWED_CODE, writeTargetsOf } from "./tool-write-out.js";

const config = {
  projects: {
    constraints: {
      [resolve("/work/secret")]: { allowedProviders: ["local-llama"] },
      [resolve("/work/secret/deeper")]: { allowedProviders: [] },
      [resolve("/work/wide")]: { allowedProviders: ["local-llama", "openai"] },
      [resolve("/work/same")]: { allowedProviders: ["local-llama"] },
      [resolve("/work/leaky")]: { allowedProviders: ["local-llama"], allowedEgress: ["web"] },
      [resolve("/work/lan")]: { allowedProviders: ["local-llama"], allowedProviderHosts: ["gpu-box.lan"] },
    },
  },
};
const secret = makeProviderPolicy({ key: resolve("/work/secret"), allowedProviders: ["local-llama"], matchedDir: resolve("/work/secret") });
const tainted = makeProviderPolicy({ key: resolve("/work/secret"), allowedProviders: ["local-llama"], matchedDir: resolve("/work/open"), readFrom: [resolve("/work/secret")] });

function guardFor(policy: ProviderPolicy | undefined, scratch?: string) {
  return createWriteOutGuard({
    policyForSession: () => policy,
    readConfig: () => config,
    ownScratchDir: () => scratch,
    realpath: () => undefined,
  });
}

describe("write-out guard (constrained content leaving its folder)", () => {
  it("names the targets of the write tools", () => {
    expect(writeTargetsOf("os.fs.write", { path: "out.md" }, resolve("/w"))).toEqual([resolve("/w/out.md")]);
    expect(writeTargetsOf("os.fs.edit", { path: resolve("/x/a") }, resolve("/w"))).toEqual([resolve("/x/a")]);
    expect(writeTargetsOf("os.fs.move", { moves: [{ from: "a", to: resolve("/x/b") }] }, resolve("/w"))).toEqual([resolve("/x/b")]);
    expect(writeTargetsOf("os.fs.archive.extract", { path: "a.zip", destDir: resolve("/x") }, resolve("/w"))).toEqual([resolve("/x")]);
    expect(writeTargetsOf("os.fs.patch", { patch: "", apply: true, rootDir: resolve("/x") }, resolve("/w"))).toEqual([resolve("/x")]);
    expect(writeTargetsOf("os.fs.patch", { patch: "", rootDir: resolve("/x") }, resolve("/w"))).toEqual([]);
    expect(writeTargetsOf("os.fs.read", { path: resolve("/x") }, resolve("/w"))).toEqual([]);
  });

  it("names the targets of upstream's document and page writers (merge 6d1f14fcd)", () => {
    expect(writeTargetsOf("os.fs.docx", { op: "append", path: resolve("/x/a.docx") }, resolve("/w"))).toEqual([resolve("/x/a.docx")]);
    expect(writeTargetsOf("os.fs.xlsx", { op: "write", path: "b.xlsx" }, resolve("/w"))).toEqual([resolve("/w/b.xlsx")]);
    expect(writeTargetsOf("os.fs.xlsx", { op: "read", path: resolve("/x/b.xlsx") }, resolve("/w"))).toEqual([]);
    expect(writeTargetsOf("os.fs.write_pptx", { path: resolve("/x/deck.pptx"), slides: [] }, resolve("/w"))).toEqual([resolve("/x/deck.pptx")]);
    // Both save next to the session: the working folder (or `output` inside it).
    expect(writeTargetsOf("video.render_html", { path: "p.html", output: "clip.mp4" }, resolve("/w"))).toEqual([resolve("/w/clip.mp4")]);
    expect(writeTargetsOf("video.render_html", { path: "p.html" }, resolve("/w"))).toEqual([resolve("/w")]);
    expect(writeTargetsOf("canvas.render", { kind: "chart" }, resolve("/w"))).toEqual([resolve("/w")]);
    // A structural rewrite writes only when applied, under `path` (default: the session folder).
    expect(writeTargetsOf("os.code.rewrite", { pattern: "a", rewrite: "b", path: resolve("/x/src"), apply: true }, resolve("/w"))).toEqual([resolve("/x/src")]);
    expect(writeTargetsOf("os.code.rewrite", { pattern: "a", rewrite: "b", apply: true }, resolve("/w"))).toEqual([resolve("/w")]);
    expect(writeTargetsOf("os.code.rewrite", { pattern: "a", rewrite: "b", path: resolve("/x/src") }, resolve("/w"))).toEqual([]);
  });

  it("refuses a tainted session's Word document in an open folder", () => {
    const refusal = guardFor(tainted)("os.fs.docx", { op: "create", path: resolve("/work/open/notes.docx") }, { sessionId: "s", workingDir: resolve("/work/open") });
    expect(refusal?.code).toBe(WRITE_OUT_NOT_ALLOWED_CODE);
  });

  it("refuses a constrained session writing outside its folder", () => {
    const guard = guardFor(secret);
    const ctx = { sessionId: "s", workingDir: resolve("/work/secret") };
    expect(guard("os.fs.write", { path: "notes.md" }, ctx)).toBeNull();
    const refused = guard("os.fs.write", { path: resolve("/work/open/notes.md") }, ctx);
    expect(refused?.message).toContain(`folder ${resolve("/work/secret")} is restricted`);
    expect(refused?.message).toContain(resolve("/work/open/notes.md"));
    expect((refused as { code?: string } | null)?.code).toBe(WRITE_OUT_NOT_ALLOWED_CODE);
    expect(guard("os.fs.move", { from: "a", to: resolve("/tmp/a") }, ctx)).not.toBeNull();
  });

  it("allows a folder with an equal or stricter constraint, never a wider one", () => {
    const guard = guardFor(secret);
    const ctx = { sessionId: "s", workingDir: resolve("/work/secret") };
    expect(guard("os.fs.write", { path: resolve("/work/secret/deeper/a") }, ctx)).toBeNull();
    expect(guard("os.fs.write", { path: resolve("/work/same/a") }, ctx)).toBeNull();
    expect(guard("os.fs.write", { path: resolve("/work/wide/a") }, ctx)).not.toBeNull();
    expect(guard("os.fs.write", { path: resolve("/work/leaky/a") }, ctx)).not.toBeNull();
    // A folder whose local provider may also be reached on another computer is wider (issue #60).
    expect(guard("os.fs.write", { path: resolve("/work/lan/a") }, ctx)).not.toBeNull();
    const lan = makeProviderPolicy({ key: resolve("/work/lan"), allowedProviders: ["local-llama"], allowedProviderHosts: ["gpu-box.lan"], matchedDir: resolve("/work/lan") });
    expect(guardFor(lan)("os.fs.write", { path: resolve("/work/same/a") }, { sessionId: "s", workingDir: resolve("/work/lan") })).toBeNull();
  });

  it("refuses a tainted session writing in its own unconstrained folder", () => {
    const guard = guardFor(tainted);
    const ctx = { sessionId: "s", workingDir: resolve("/work/open") };
    expect(guard("os.fs.write", { path: "copy.md" }, ctx)?.message).toContain(`read files from ${resolve("/work/secret")}`);
    expect(guard("os.fs.write", { path: resolve("/work/secret/copy.md") }, ctx)).toBeNull();
  });

  it("lets a fusion worker write inside its own temp copy, and an unconstrained session anywhere", () => {
    const worker = guardFor(secret, resolve("/tmp/atag-fusion-1/w"));
    expect(worker("os.fs.write", { path: "a.ts" }, { sessionId: "w", workingDir: resolve("/tmp/atag-fusion-1/w") })).toBeNull();
    expect(worker("os.fs.write", { path: resolve("/tmp/elsewhere") }, { sessionId: "w", workingDir: resolve("/tmp/atag-fusion-1/w") })).not.toBeNull();
    expect(guardFor(undefined)("os.fs.write", { path: resolve("/anywhere") }, { sessionId: "s", workingDir: resolve("/w") })).toBeNull();
  });
});
