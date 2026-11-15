import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasConstrainedFolderInside,
  hasProjectConstraints,
  makeProviderPolicy,
  normalizeConstraintPath,
  providerPolicyFromStamp,
  resolveProjectConstraint,
  toProviderPolicyStamp,
} from "./project-constraint-match.js";

type Constraints = Record<string, { allowedProviders: string[]; allowedEgress?: string[] }>;
const cfg = (constraints: Constraints) => ({ projects: { roots: [], constraints } });
const noReal = () => undefined;

describe("normalizeConstraintPath", () => {
  it("strips a trailing separator on POSIX but keeps the root", () => {
    expect(normalizeConstraintPath("/work/client/", "linux")).toBe("/work/client");
    expect(normalizeConstraintPath("/", "linux")).toBe("/");
  });

  it("is case-sensitive on POSIX", () => {
    expect(normalizeConstraintPath("/Work", "linux")).toBe("/Work");
  });

  it("folds case on macOS, whose default file system is case-insensitive", () => {
    expect(normalizeConstraintPath("/Users/Me/Client/", "darwin")).toBe("/users/me/client");
  });

  it("matches a differently-cased folder on macOS but not on Linux", () => {
    const c = cfg({ "/Users/me/Client": { allowedProviders: ["local-llama"] } });
    expect(resolveProjectConstraint(c, "/users/ME/client/src", { platform: "darwin", realpath: noReal })?.key).toBe("/Users/me/Client");
    expect(resolveProjectConstraint(c, "/users/ME/client/src", { platform: "linux", realpath: noReal })).toBeUndefined();
  });

  it("folds case, separators, trailing slash and the \\\\?\\ prefix on Windows", () => {
    expect(normalizeConstraintPath("C:/Work/Client/", "win32")).toBe("c:\\work\\client");
    expect(normalizeConstraintPath("\\\\?\\C:\\Work\\Client", "win32")).toBe("c:\\work\\client");
    expect(normalizeConstraintPath("c:\\work\\", "win32")).toBe("c:\\work");
    expect(normalizeConstraintPath("C:\\", "win32")).toBe("c:\\");
  });

  it("maps \\\\?\\UNC\\ to the plain UNC form on Windows", () => {
    expect(normalizeConstraintPath("\\\\?\\UNC\\Server\\Share\\X", "win32")).toBe("\\\\server\\share\\x");
    expect(normalizeConstraintPath("//server/share/x/", "win32")).toBe("\\\\server\\share\\x");
  });
});

describe("resolveProjectConstraint", () => {
  it("is undefined with no constraint and reports none configured", () => {
    expect(resolveProjectConstraint(cfg({}), "/work", { platform: "linux", realpath: noReal })).toBeUndefined();
    expect(hasProjectConstraints(cfg({}))).toBe(false);
    expect(hasProjectConstraints(cfg({ "/w": { allowedProviders: [] } }))).toBe(true);
  });

  it("matches the folder itself and anything under it", () => {
    const c = cfg({ "/work/client": { allowedProviders: ["local-llama"] } });
    const at = resolveProjectConstraint(c, "/work/client", { platform: "linux", realpath: noReal });
    expect(at?.key).toBe("/work/client");
    expect(at?.allowedProviders).toEqual(["local-llama"]);
    expect(at?.allows("local-llama")).toBe(true);
    expect(at?.allows("openai")).toBe(false);
    expect(resolveProjectConstraint(c, "/work/client/src/deep", { platform: "linux", realpath: noReal })?.key).toBe("/work/client");
  });

  it("does not match a sibling that shares the prefix", () => {
    const c = cfg({ "/work/client": { allowedProviders: ["local-llama"] } });
    expect(resolveProjectConstraint(c, "/work/client-other", { platform: "linux", realpath: noReal })).toBeUndefined();
    expect(resolveProjectConstraint(c, "/work", { platform: "linux", realpath: noReal })).toBeUndefined();
    expect(resolveProjectConstraint(c, "/work/..client", { platform: "linux", realpath: noReal })).toBeUndefined();
  });

  it("lets the longest (most specific) entry win for nested folders", () => {
    const c = cfg({
      "/work": { allowedProviders: ["local-llama", "openai"] },
      "/work/secret": { allowedProviders: ["local-llama"] },
    });
    expect(resolveProjectConstraint(c, "/work/secret/x", { platform: "linux", realpath: noReal })?.key).toBe("/work/secret");
    expect(resolveProjectConstraint(c, "/work/public", { platform: "linux", realpath: noReal })?.key).toBe("/work");
  });

  it("matches on Windows regardless of case, separators, trailing slash and \\\\?\\", () => {
    const c = cfg({ "C:\\Work\\Client\\": { allowedProviders: ["local-llama"] } });
    const opts = { platform: "win32" as const, realpath: noReal };
    expect(resolveProjectConstraint(c, "c:/work/client/src", opts)?.key).toBe("C:\\Work\\Client\\");
    expect(resolveProjectConstraint(c, "\\\\?\\C:\\WORK\\CLIENT", opts)).toBeDefined();
    expect(resolveProjectConstraint(c, "C:\\Work\\Client-2", opts)).toBeUndefined();
    expect(resolveProjectConstraint(c, "D:\\Work\\Client", opts)).toBeUndefined();
  });

  it("matches UNC shares on Windows", () => {
    const c = cfg({ "\\\\Server\\Share\\Proj": { allowedProviders: [] } });
    const opts = { platform: "win32" as const, realpath: noReal };
    expect(resolveProjectConstraint(c, "\\\\?\\UNC\\server\\share\\proj\\a", opts)).toBeDefined();
    expect(resolveProjectConstraint(c, "\\\\server\\share\\project", opts)).toBeUndefined();
  });

  it("matches the real path when the session folder is reached through a link", () => {
    const opts = {
      platform: "linux" as const,
      realpath: (p: string) => (p === "/home/me/link" ? "/data/secret" : p.startsWith("/home/me/link/") ? `/data/secret/${p.slice("/home/me/link/".length)}` : undefined),
    };
    const c = cfg({ "/data/secret": { allowedProviders: ["local-llama"] } });
    expect(resolveProjectConstraint(c, "/home/me/link/src", opts)?.key).toBe("/data/secret");
  });

  describe("against the real file system", () => {
    let root: string | undefined;
    afterEach(() => {
      if (root) rmSync(root, { recursive: true, force: true });
      root = undefined;
    });

    it("follows a symlink with the default realpath", () => {
      root = mkdtempSync(join(tmpdir(), "pc-match-"));
      const real = join(root, "real");
      mkdirSync(join(real, "sub"), { recursive: true });
      const link = join(root, "link");
      symlinkSync(real, link, "junction");
      const c = cfg({ [real]: { allowedProviders: ["local-llama"] } });
      expect(resolveProjectConstraint(c, join(link, "sub"))?.key).toBe(real);
      // And an entry written through the link covers the real folder.
      const viaLink = cfg({ [link]: { allowedProviders: [] } });
      expect(resolveProjectConstraint(viaLink, join(real, "sub"))?.key).toBe(link);
    });
  });
});

describe("allowedEgress on the policy", () => {
  it("defaults to no egress class in a constrained folder", () => {
    const policy = resolveProjectConstraint(cfg({ "/w": { allowedProviders: ["local-llama"] } }), "/w/a", { realpath: noReal, platform: "linux" });
    expect(policy?.allowedEgress).toEqual([]);
    expect(policy?.allowsEgress("web")).toBe(false);
  });

  it("carries the entry's classes and answers for them", () => {
    const policy = resolveProjectConstraint(cfg({ "/w": { allowedProviders: [], allowedEgress: ["web", "mcp:docs"] } }), "/w", { realpath: noReal, platform: "linux" });
    expect(policy?.allowsEgress("web")).toBe(true);
    expect(policy?.allowsEgress("mcp:docs")).toBe(true);
    expect(policy?.allowsEgress("mcp:other")).toBe(false);
    expect(policy?.allowsEgress("github")).toBe(false);
  });

  it("survives a stamp round trip, and a stamp without the list allows no egress (fail closed)", () => {
    const policy = makeProviderPolicy({ key: "/w", allowedProviders: ["a"], allowedEgress: ["http"], matchedDir: "/w" });
    const back = providerPolicyFromStamp(toProviderPolicyStamp(policy));
    expect(back?.allowedEgress).toEqual(["http"]);
    expect(providerPolicyFromStamp({ key: "/w", allowedProviders: ["a"], matchedDir: "/w" })?.allowedEgress).toEqual([]);
    expect(providerPolicyFromStamp({ key: "/w", allowedProviders: ["a"], allowedEgress: "web", matchedDir: "/w" })).toBeUndefined();
  });
});

describe("hasConstrainedFolderInside (the LSP root check, ATO-503)", () => {
  const config = { projects: { constraints: { "/work/repo/secret": { allowedProviders: ["local-llama"] } } } };
  const opts = { platform: "linux" as const, realpath: () => undefined };
  it("is true for a folder that holds a constrained one below it", () => {
    expect(hasConstrainedFolderInside(config, "/work/repo", opts)).toBe(true);
    expect(hasConstrainedFolderInside(config, "/work", opts)).toBe(true);
  });
  it("is false for the constrained folder itself, a folder inside it, a sibling, or no constraints", () => {
    expect(hasConstrainedFolderInside(config, "/work/repo/secret", opts)).toBe(false);
    expect(hasConstrainedFolderInside(config, "/work/repo/secret/src", opts)).toBe(false);
    expect(hasConstrainedFolderInside(config, "/work/other", opts)).toBe(false);
    expect(hasConstrainedFolderInside({ projects: {} }, "/work/repo", opts)).toBe(false);
  });
});
