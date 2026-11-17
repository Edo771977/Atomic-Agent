import { describe, expect, it } from "vitest";

import { makeProviderPolicy, type ProviderPolicy } from "../config/project-constraint-match.js";
import { createWriteOutGuard, WRITE_OUT_NOT_ALLOWED_CODE, writeTargetsOf } from "./tool-write-out.js";

const config = {
  projects: {
    constraints: {
      "/work/secret": { allowedProviders: ["local-llama"] },
      "/work/secret/deeper": { allowedProviders: [] },
      "/work/wide": { allowedProviders: ["local-llama", "openai"] },
      "/work/same": { allowedProviders: ["local-llama"] },
      "/work/leaky": { allowedProviders: ["local-llama"], allowedEgress: ["web"] },
      "/work/lan": { allowedProviders: ["local-llama"], allowedProviderHosts: ["gpu-box.lan"] },
    },
  },
};
const secret = makeProviderPolicy({ key: "/work/secret", allowedProviders: ["local-llama"], matchedDir: "/work/secret" });
const tainted = makeProviderPolicy({ key: "/work/secret", allowedProviders: ["local-llama"], matchedDir: "/work/open", readFrom: ["/work/secret"] });

function guardFor(policy: ProviderPolicy | undefined, scratch?: string) {
  return createWriteOutGuard({
    policyForSession: () => policy,
    readConfig: () => config,
    ownScratchDir: () => scratch,
    platform: "linux",
    realpath: () => undefined,
  });
}

describe("write-out guard (constrained content leaving its folder)", () => {
  it("names the targets of the write tools", () => {
    expect(writeTargetsOf("os.fs.write", { path: "out.md" }, "/w")).toEqual(["/w/out.md"]);
    expect(writeTargetsOf("os.fs.edit", { path: "/x/a" }, "/w")).toEqual(["/x/a"]);
    expect(writeTargetsOf("os.fs.move", { moves: [{ from: "a", to: "/x/b" }] }, "/w")).toEqual(["/x/b"]);
    expect(writeTargetsOf("os.fs.archive.extract", { path: "a.zip", destDir: "/x" }, "/w")).toEqual(["/x"]);
    expect(writeTargetsOf("os.fs.patch", { patch: "", apply: true, rootDir: "/x" }, "/w")).toEqual(["/x"]);
    expect(writeTargetsOf("os.fs.patch", { patch: "", rootDir: "/x" }, "/w")).toEqual([]);
    expect(writeTargetsOf("os.fs.read", { path: "/x" }, "/w")).toEqual([]);
  });

  it("names the targets of upstream's document and page writers (merge 6d1f14fcd)", () => {
    expect(writeTargetsOf("os.fs.docx", { op: "append", path: "/x/a.docx" }, "/w")).toEqual(["/x/a.docx"]);
    expect(writeTargetsOf("os.fs.xlsx", { op: "write", path: "b.xlsx" }, "/w")).toEqual(["/w/b.xlsx"]);
    expect(writeTargetsOf("os.fs.xlsx", { op: "read", path: "/x/b.xlsx" }, "/w")).toEqual([]);
    expect(writeTargetsOf("os.fs.write_pptx", { path: "/x/deck.pptx", slides: [] }, "/w")).toEqual(["/x/deck.pptx"]);
    // Both save next to the session: the working folder (or `output` inside it).
    expect(writeTargetsOf("video.render_html", { path: "p.html", output: "clip.mp4" }, "/w")).toEqual(["/w/clip.mp4"]);
    expect(writeTargetsOf("video.render_html", { path: "p.html" }, "/w")).toEqual(["/w"]);
    expect(writeTargetsOf("canvas.render", { kind: "chart" }, "/w")).toEqual(["/w"]);
    // A structural rewrite writes only when applied, under `path` (default: the session folder).
    expect(writeTargetsOf("os.code.rewrite", { pattern: "a", rewrite: "b", path: "/x/src", apply: true }, "/w")).toEqual(["/x/src"]);
    expect(writeTargetsOf("os.code.rewrite", { pattern: "a", rewrite: "b", apply: true }, "/w")).toEqual(["/w"]);
    expect(writeTargetsOf("os.code.rewrite", { pattern: "a", rewrite: "b", path: "/x/src" }, "/w")).toEqual([]);
  });

  it("refuses a tainted session's Word document in an open folder", () => {
    const refusal = guardFor(tainted)("os.fs.docx", { op: "create", path: "/work/open/notes.docx" }, { sessionId: "s", workingDir: "/work/open" });
    expect(refusal?.code).toBe(WRITE_OUT_NOT_ALLOWED_CODE);
  });

  it("refuses a constrained session writing outside its folder", () => {
    const guard = guardFor(secret);
    const ctx = { sessionId: "s", workingDir: "/work/secret" };
    expect(guard("os.fs.write", { path: "notes.md" }, ctx)).toBeNull();
    const refused = guard("os.fs.write", { path: "/work/open/notes.md" }, ctx);
    expect(refused?.message).toContain("folder /work/secret is restricted");
    expect(refused?.message).toContain("/work/open/notes.md");
    expect((refused as { code?: string } | null)?.code).toBe(WRITE_OUT_NOT_ALLOWED_CODE);
    expect(guard("os.fs.move", { from: "a", to: "/tmp/a" }, ctx)).not.toBeNull();
  });

  it("allows a folder with an equal or stricter constraint, never a wider one", () => {
    const guard = guardFor(secret);
    const ctx = { sessionId: "s", workingDir: "/work/secret" };
    expect(guard("os.fs.write", { path: "/work/secret/deeper/a" }, ctx)).toBeNull();
    expect(guard("os.fs.write", { path: "/work/same/a" }, ctx)).toBeNull();
    expect(guard("os.fs.write", { path: "/work/wide/a" }, ctx)).not.toBeNull();
    expect(guard("os.fs.write", { path: "/work/leaky/a" }, ctx)).not.toBeNull();
    // A folder whose local provider may also be reached on another computer is wider (issue #60).
    expect(guard("os.fs.write", { path: "/work/lan/a" }, ctx)).not.toBeNull();
    const lan = makeProviderPolicy({ key: "/work/lan", allowedProviders: ["local-llama"], allowedProviderHosts: ["gpu-box.lan"], matchedDir: "/work/lan" });
    expect(guardFor(lan)("os.fs.write", { path: "/work/same/a" }, { sessionId: "s", workingDir: "/work/lan" })).toBeNull();
  });

  it("refuses a tainted session writing in its own unconstrained folder", () => {
    const guard = guardFor(tainted);
    const ctx = { sessionId: "s", workingDir: "/work/open" };
    expect(guard("os.fs.write", { path: "copy.md" }, ctx)?.message).toContain("read files from /work/secret");
    expect(guard("os.fs.write", { path: "/work/secret/copy.md" }, ctx)).toBeNull();
  });

  it("lets a fusion worker write inside its own temp copy, and an unconstrained session anywhere", () => {
    const worker = guardFor(secret, "/tmp/atag-fusion-1/w");
    expect(worker("os.fs.write", { path: "a.ts" }, { sessionId: "w", workingDir: "/tmp/atag-fusion-1/w" })).toBeNull();
    expect(worker("os.fs.write", { path: "/tmp/elsewhere" }, { sessionId: "w", workingDir: "/tmp/atag-fusion-1/w" })).not.toBeNull();
    expect(guardFor(undefined)("os.fs.write", { path: "/anywhere" }, { sessionId: "s", workingDir: "/w" })).toBeNull();
  });
});
