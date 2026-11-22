import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { makeProviderPolicy } from "../config/project-constraint-match.js";
import { findSessionReadOutside, readTaintTargets, sessionReadRoots } from "./read-scope/index.js";
import { createWriteOutGuard, writeTargetsOf } from "./tool-write-out.js";

/**
 * Issue #74 item 10: `os.git.clone` from a local path reads that
 * repository (taint, read scope) and writes its `dest` (write-out); the
 * git mutations write into `repo` (or the working directory).
 */
const wd = resolve("/work/open");

describe("os.git.clone from a local path", () => {
  it("reads a local url: a path, a relative path from dest's parent, a file:// url", () => {
    expect(readTaintTargets("os.git.clone", { url: resolve("/work/secret/repo"), dest: resolve("/work/open/copy") }, wd)).toEqual([resolve("/work/secret/repo")]);
    expect(readTaintTargets("os.git.clone", { url: pathToFileURL(resolve("/work/secret/repo")).href }, wd)).toEqual([resolve("/work/secret/repo")]);
    expect(readTaintTargets("os.git.clone", { url: "../secret/repo" }, wd)).toEqual([resolve("/work/secret/repo")]);
    expect(readTaintTargets("os.git.clone", { url: "../repo", dest: resolve("/work/secret/sub/copy") }, wd)).toEqual([resolve("/work/secret/repo")]);
  });

  it("a remote url is not a read", () => {
    for (const url of ["https://github.com/x/y.git", "git@github.com:x/y.git", "github.com:x/y", "ssh://host/x"]) {
      expect(readTaintTargets("os.git.clone", { url }, wd), url).toEqual([]);
    }
  });

  it("the read scope asks about a local clone source outside the roots", () => {
    const ctx = { sessionId: "s", workingDir: resolve("/srv/me/project") };
    expect(findSessionReadOutside("os.git.clone", { url: resolve("/srv/other/repo") }, ctx, sessionReadRoots(ctx))).toBe(resolve("/srv/other/repo"));
    expect(findSessionReadOutside("os.git.clone", { url: "https://github.com/x/y" }, ctx, sessionReadRoots(ctx))).toBeNull();
  });

  it("dest (default: the working directory) is a write target", () => {
    expect(writeTargetsOf("os.git.clone", { url: resolve("/work/secret/repo"), dest: resolve("/work/open/copy") }, wd)).toEqual([resolve("/work/open/copy")]);
    expect(writeTargetsOf("os.git.clone", { url: "https://github.com/x/y" }, wd)).toEqual([wd]);
  });
});

describe("git mutations write into their repository", () => {
  it("names repo, or the working directory, for add, commit, checkout, merge and init", () => {
    expect(writeTargetsOf("os.git.commit", { repo: resolve("/work/open/repo"), message: "x" }, resolve("/work/secret"))).toEqual([resolve("/work/open/repo")]);
    expect(writeTargetsOf("os.git.add", { paths: ["a"] }, wd)).toEqual([wd]);
    expect(writeTargetsOf("os.git.checkout", { repo: "r", ref: "main" }, wd)).toEqual([resolve("/work/open/r")]);
    expect(writeTargetsOf("os.git.merge", { repo: resolve("/x"), branch: "b" }, wd)).toEqual([resolve("/x")]);
    expect(writeTargetsOf("os.git.init", { path: resolve("/x/new") }, wd)).toEqual([resolve("/x/new")]);
    expect(writeTargetsOf("os.git.init", {}, wd)).toEqual([wd]);
  });

  it("a constrained session may not commit into an open repository", () => {
    const secret = makeProviderPolicy({ key: resolve("/work/secret"), allowedProviders: ["local-llama"], matchedDir: resolve("/work/secret") });
    const guard = createWriteOutGuard({
      policyForSession: () => secret,
      readConfig: () => ({ projects: { constraints: { [resolve("/work/secret")]: { allowedProviders: ["local-llama"] } } } }),
      ownScratchDir: () => undefined,
      realpath: () => undefined,
    });
    const ctx = { sessionId: "s", workingDir: resolve("/work/secret") };
    expect(guard("os.git.commit", { repo: resolve("/work/open/repo"), message: "x" }, ctx)).not.toBeNull();
    expect(guard("os.git.commit", { message: "x" }, ctx)).toBeNull();
    expect(guard("os.git.clone", { url: resolve("/work/secret/repo"), dest: resolve("/work/open/copy") }, ctx)).not.toBeNull();
  });
});
