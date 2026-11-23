import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { requireSymlinks } from "../../../test-symlink-support.js";
import { categorizeFsMutation, resolveFsScope } from "./fs-approval-scope.js";

const directoryLink = process.platform === "win32" ? "junction" : "dir";

describe("fs approval scope", () => {
  let root: string;
  let workspace: string;
  let home: string;
  let elsewhere: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fs-scope-"));
    workspace = join(root, "workspace");
    home = join(root, "home");
    elsewhere = join(root, "elsewhere");
    await mkdir(workspace, { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // No trust-config paths by default so the scope/category tests stay
  // pure; the trust-config guard has its own block below.
  const opts = () => ({
    workingDir: workspace,
    homeDir: home,
    trustConfigPaths: [] as string[],
  });

  it("classifies existing and not-yet-existing paths inside the workspace", async () => {
    await writeFile(join(workspace, "a.txt"), "x", "utf8");
    expect(await resolveFsScope([join(workspace, "a.txt")], opts())).toBe(
      "workspace",
    );
    // fs.write creates files: the leaf (and even parents) may not exist yet.
    expect(
      await resolveFsScope([join(workspace, "new", "deep", "b.txt")], opts()),
    ).toBe("workspace");
    // The workspace root itself counts as inside.
    expect(await resolveFsScope([workspace], opts())).toBe("workspace");
  });

  it("classifies home and outside paths", async () => {
    expect(await resolveFsScope([join(home, "notes.txt")], opts())).toBe(
      "home",
    );
    expect(await resolveFsScope([join(elsewhere, "x.txt")], opts())).toBe(
      "outside",
    );
    // Prefix trick: /root/home-evil must not match /root/home.
    expect(await resolveFsScope([`${home}-evil/notes.txt`], opts())).toBe(
      "outside",
    );
  });

  it("a symlink inside the workspace that points outside is NOT workspace", async () => {
    await symlink(elsewhere, join(workspace, "link-out"), directoryLink);
    expect(
      await resolveFsScope([join(workspace, "link-out", "f.txt")], opts()),
    ).toBe("outside");
    await mkdir(join(home, "sub"), { recursive: true });
    await symlink(join(home, "sub"), join(workspace, "link-home"), directoryLink);
    expect(
      await resolveFsScope([join(workspace, "link-home", "f.txt")], opts()),
    ).toBe("home");
  });

  it("C2: a DANGLING symlink in the workspace pointing outside classifies by target (asks)", async (context) => {
    requireSymlinks(context);
    // Broken link leak.txt -> /elsewhere/ghost.txt (target does not
    // exist). realpath(leak.txt) throws ENOENT; the naive
    // deepest-existing-ancestor fallback would re-glue the leaf to the
    // workspace and call it "workspace" (silent at L2) even though
    // writeFile through the link creates the file OUTSIDE. We must
    // classify by the link target.
    const danglingOut = join(workspace, "leak.txt");
    await symlink(join(elsewhere, "ghost.txt"), danglingOut);
    expect(await resolveFsScope([danglingOut], opts())).toBe("outside");
    expect(await categorizeFsMutation("write", [danglingOut], opts())).toBe(
      "other",
    );
  });

  it("C2: a dangling symlink to a not-yet-existing file INSIDE the workspace stays workspace", async (context) => {
    requireSymlinks(context);
    // The legitimate case: a link to a workspace file that has not been
    // created yet must still be a workspace write (silent at L2).
    const danglingIn = join(workspace, "pending.txt");
    await symlink(join(workspace, "sub", "new.txt"), danglingIn);
    expect(await resolveFsScope([danglingIn], opts())).toBe("workspace");
    expect(await categorizeFsMutation("write", [danglingIn], opts())).toBe(
      "fs_write_workspace",
    );
  });

  it("C2: a chain of dangling symlinks is followed to where the write lands", async (context) => {
    requireSymlinks(context);
    // a -> b -> /elsewhere/ghost.txt, none existing: still outside.
    await symlink(join(workspace, "b.txt"), join(workspace, "a.txt"));
    await symlink(join(elsewhere, "ghost.txt"), join(workspace, "b.txt"));
    expect(await resolveFsScope([join(workspace, "a.txt")], opts())).toBe(
      "outside",
    );
  });

  it("a symlinked workspace root still contains its own files (realpath both sides)", async () => {
    const linkedWorkspace = join(root, "ws-link");
    await symlink(workspace, linkedWorkspace, directoryLink);
    expect(
      await resolveFsScope([join(workspace, "f.txt")], {
        workingDir: linkedWorkspace,
        homeDir: home,
      }),
    ).toBe("workspace");
  });

  it("combines multiple paths to the weakest scope", async () => {
    expect(
      await resolveFsScope([join(workspace, "a"), join(home, "b")], opts()),
    ).toBe("home");
    expect(
      await resolveFsScope(
        [join(workspace, "a"), join(elsewhere, "b")],
        opts(),
      ),
    ).toBe("outside");
    expect(await resolveFsScope([], opts())).toBe("outside");
  });

  it("relative segments are expected pre-resolved; resolve() output classifies correctly", async () => {
    // Tools hand in resolveUserPath() output (absolute, lexically
    // collapsed) — mirror that here.
    const collapsed = resolve(workspace, "sub", "..", "c.txt");
    expect(await resolveFsScope([collapsed], opts())).toBe("workspace");
  });

  it("maps write/trash/extract kinds onto the ladder categories", async () => {
    const ws = join(workspace, "f.txt");
    const hm = join(home, "f.txt");
    const out = join(elsewhere, "f.txt");

    expect(await categorizeFsMutation("write", [ws], opts())).toBe(
      "fs_write_workspace",
    );
    expect(await categorizeFsMutation("write", [hm], opts())).toBe(
      "fs_write_home",
    );
    expect(await categorizeFsMutation("write", [out], opts())).toBe("other");

    // Trash goes silent at level 3 even for workspace paths: level 2
    // deliberately covers plain writes only.
    expect(await categorizeFsMutation("trash", [ws], opts())).toBe("fs_trash");
    expect(await categorizeFsMutation("trash", [hm], opts())).toBe("fs_trash");
    expect(await categorizeFsMutation("trash", [out], opts())).toBe("other");

    // Extraction materialises unreviewed archive content: level 3 even
    // when the destination is the workspace.
    expect(await categorizeFsMutation("extract", [ws], opts())).toBe(
      "fs_write_home",
    );
    expect(await categorizeFsMutation("extract", [hm], opts())).toBe(
      "fs_write_home",
    );
    expect(await categorizeFsMutation("extract", [out], opts())).toBe("other");
  });

  it("falls back to outside (asks) when the workspace root itself is unresolvable", async () => {
    expect(
      await resolveFsScope([join(workspace, "f.txt")], {
        workingDir: join(root, "does-not-exist"),
        homeDir: home,
        trustConfigPaths: [],
      }),
    ).toBe("outside");
  });

  describe("C1: trust-config guard (config.json / .env)", () => {
    // The state dir sits under home in production, so config.json would
    // otherwise be fs_write_home (silent at L3) and a model at L3/L4
    // could rewrite its own approvalLevel to 5 with no prompt.
    let stateDir: string;
    let configFile: string;
    let envFile: string;

    beforeEach(async () => {
      stateDir = join(home, ".atomic-agent");
      configFile = join(stateDir, "config.json");
      envFile = join(stateDir, ".env");
      await mkdir(stateDir, { recursive: true });
      await writeFile(configFile, "{}", "utf8");
      await writeFile(envFile, "SECRET=1", "utf8");
    });

    const trustOpts = () => ({
      workingDir: workspace,
      homeDir: home,
      trustConfigPaths: [configFile, envFile],
    });

    it("write/edit/patch to config.json is trust_config (asks until L5)", async () => {
      expect(
        await categorizeFsMutation("write", [configFile], trustOpts()),
      ).toBe("trust_config");
    });

    it("write to .env (API tokens) is trust_config too", async () => {
      expect(await categorizeFsMutation("write", [envFile], trustOpts())).toBe(
        "trust_config",
      );
    });

    it("trashing the config file is a trust mutation as well", async () => {
      expect(
        await categorizeFsMutation("trash", [configFile], trustOpts()),
      ).toBe("trust_config");
    });

    it("a batch that includes config.json is trust_config even alongside a plain file", async () => {
      expect(
        await categorizeFsMutation(
          "write",
          [join(workspace, "ok.txt"), configFile],
          trustOpts(),
        ),
      ).toBe("trust_config");
    });

    it("catches a symlink detour to config.json (compared on realpath, not string)", async (context) => {
      requireSymlinks(context);
      const decoy = join(workspace, "innocent.json");
      await symlink(configFile, decoy);
      expect(await categorizeFsMutation("write", [decoy], trustOpts())).toBe(
        "trust_config",
      );
    });

    it("catches a `..` path that resolves to config.json", async () => {
      const detour = join(stateDir, "sub", "..", "config.json");
      await mkdir(join(stateDir, "sub"), { recursive: true });
      expect(await categorizeFsMutation("write", [detour], trustOpts())).toBe(
        "trust_config",
      );
    });

    it("a not-yet-existing .env on a fresh install still matches", async () => {
      await rm(envFile, { force: true });
      expect(await categorizeFsMutation("write", [envFile], trustOpts())).toBe(
        "trust_config",
      );
    });

    it("a normal file next to config.json is NOT trust_config", async () => {
      expect(
        await categorizeFsMutation(
          "write",
          [join(stateDir, "notes.txt")],
          trustOpts(),
        ),
      ).toBe("fs_write_home");
    });

    it("extraction into a directory that holds a trust file is trust_config", async () => {
      expect(
        await categorizeFsMutation("extract", [stateDir], trustOpts()),
      ).toBe("trust_config");
    });

    it("extraction elsewhere stays on the scope ladder", async () => {
      expect(
        await categorizeFsMutation("extract", [join(home, "unpacked")], trustOpts()),
      ).toBe("fs_write_home");
    });

    describe("directory entries (trailing separator)", () => {
      const withInstalled = () => ({
        ...trustOpts(),
        trustConfigPaths: [
          configFile,
          join(stateDir, "plugins", "installed") + sep,
        ],
      });

      it("a write anywhere under the directory is trust_config, new files included", async () => {
        expect(
          await categorizeFsMutation(
            "write",
            [join(stateDir, "plugins", "installed", "x", "hooks", "run.sh")],
            withInstalled(),
          ),
        ).toBe("trust_config");
      });

      it("a sibling with the same name prefix does not match", async () => {
        expect(
          await categorizeFsMutation(
            "write",
            [join(stateDir, "plugins", "installed-notes.txt")],
            withInstalled(),
          ),
        ).toBe("fs_write_home");
      });

      it("catches a symlink into the directory", async () => {
        const inside = join(stateDir, "plugins", "installed", "x");
        await mkdir(inside, { recursive: true });
        await symlink(inside, join(workspace, "linked"), directoryLink);
        expect(
          await categorizeFsMutation("write", [join(workspace, "linked", "a.sh")], withInstalled()),
        ).toBe("trust_config");
      });

      it("extraction under the directory is trust_config", async () => {
        expect(
          await categorizeFsMutation(
            "extract",
            [join(stateDir, "plugins", "installed", "x")],
            withInstalled(),
          ),
        ).toBe("trust_config");
      });
    });
  });

  describe("a fusion project's store (issue #109)", () => {
    it("a write, trash or extraction into .atomic/project is trust_config (asks until L5), even with no trust list", async () => {
      const store = join(workspace, ".atomic", "project");
      await mkdir(store, { recursive: true });
      await writeFile(join(store, "project.json"), "{}", "utf8");
      expect(await categorizeFsMutation("write", [join(store, "project.json")], opts())).toBe("trust_config");
      expect(await categorizeFsMutation("write", [join(workspace, "sub", ".atomic", "project", "PLAN.md")], opts())).toBe("trust_config");
      expect(await categorizeFsMutation("trash", [store], opts())).toBe("trust_config");
      expect(await categorizeFsMutation("trash", [join(workspace, ".atomic")], opts())).toBe("trust_config");
      expect(await categorizeFsMutation("extract", [workspace], opts())).toBe("trust_config");
      // Anything under .atomic, and .atomic itself (a move of it), counts.
      expect(await categorizeFsMutation("write", [join(workspace, ".atomic", "notes.md")], opts())).toBe("trust_config");
    });

    it("a symlink into the store is classified by its target", async (context) => {
      requireSymlinks(context);
      const store = join(workspace, ".atomic", "project");
      await mkdir(store, { recursive: true });
      await symlink(join(store, "project.json"), join(workspace, "link.json"));
      expect(await categorizeFsMutation("write", [join(workspace, "link.json")], opts())).toBe("trust_config");
    });
  });
});


describe("the fusion projects' records in the state dir (issue #109 review)", () => {
  it("protects mutations and shell path recognition for global and shared skill roots", async () => {
    const { getTrustConfigPaths, getStateSecretPaths } = await import("../../../config/config-file.js");
    const home = await mkdtemp(join(tmpdir(), "fs-scope-skills-"));
    const restore = process.env.ATOMIC_AGENT_SHARED_SKILLS_DIR;
    try {
      const stateDir = join(home, "state");
      const globalSkillsDir = join(home, "custom-skills");
      const shared = join(home, "shared-skills");
      process.env.ATOMIC_AGENT_SHARED_SKILLS_DIR = shared;
      const paths = { stateDir, globalSkillsDir, userConfigFile: join(stateDir, "config.json"), localModelsDataDir: join(stateDir, "models") };
      const trustConfigPaths = getTrustConfigPaths(paths);
      for (const root of [globalSkillsDir, shared]) {
        const target = join(root, "demo", "SKILL.md");
        const options = { workingDir: home, homeDir: home, trustConfigPaths };
        expect(await categorizeFsMutation("write", [target], options)).toBe("trust_config");
        expect(await categorizeFsMutation("write", [join(home, "source"), target], options)).toBe("trust_config");
        expect(await categorizeFsMutation("trash", [target], options)).toBe("trust_config");
      }
      const shellPaths = getStateSecretPaths(paths);
      expect(shellPaths).toEqual(expect.arrayContaining([...trustConfigPaths]));
    } finally {
      if (restore === undefined) delete process.env.ATOMIC_AGENT_SHARED_SKILLS_DIR;
      else process.env.ATOMIC_AGENT_SHARED_SKILLS_DIR = restore;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("a write there is trust_config, like config.json (review a6)", async () => {
    const { getTrustConfigPaths } = await import("../../../config/config-file.js");
    const home = await mkdtemp(join(tmpdir(), "fs-scope-records-"));
    try {
      const stateDir = join(home, ".atomic-agent");
      const trust = getTrustConfigPaths({ userConfigFile: join(stateDir, "config.json"), stateDir, localModelsDataDir: join(stateDir, "models") });
      const o = { workingDir: join(home, "proj"), homeDir: home, trustConfigPaths: trust };
      for (const key of [join(stateDir, "serve-api.key"), join(stateDir, "models", "llama-server.key")]) {
        expect(await categorizeFsMutation("write", [key], o)).toBe("trust_config");
        expect(await categorizeFsMutation("write", [key, join(home, "moved")], o)).toBe("trust_config");
        expect(await categorizeFsMutation("trash", [key], o)).toBe("trust_config");
      }
      expect(await categorizeFsMutation("write", [join(stateDir, "project-decisions", "abc.json")], o)).toBe("trust_config");
      expect(await categorizeFsMutation("write", [join(stateDir, "learned-projects", "abc", "skills", "notes", "SKILL.md")], o)).toBe("trust_config");
      expect(await categorizeFsMutation("write", [join(stateDir, "projects", "registry.json")], o)).toBe("trust_config");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("moves, links and extraction around a project's store (issue #109 review a2)", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "fs-scope-atomic-"));
    await mkdir(join(ws, ".atomic", "project"), { recursive: true });
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });
  const o = () => ({ workingDir: ws, homeDir: join(ws, "nohome"), trustConfigPaths: [] as string[] });

  it("moving .atomic out, or a folder onto it, is trust_config", async () => {
    expect(await categorizeFsMutation("write", [join(ws, ".atomic"), join(ws, "moved")], o())).toBe("trust_config");
    expect(await categorizeFsMutation("write", [join(ws, "staged"), join(ws, ".atomic")], o())).toBe("trust_config");
    expect(await categorizeFsMutation("write", [join(ws, ".atomic", ".", "project", "..", "project", "project.json")], o())).toBe("trust_config");
  });

  it("a .atomic that is a symlink is caught by its name and by its target", async () => {
    const real = join(ws, "real-store");
    await mkdir(join(real, "project"), { recursive: true });
    const linked = join(ws, "sub");
    await mkdir(linked);
    await symlink(real, join(linked, ".atomic"), directoryLink);
    expect(await categorizeFsMutation("write", [join(linked, ".atomic", "project", "project.json")], o())).toBe("trust_config");
    await symlink(join(ws, ".atomic", "project"), join(ws, "alias"), directoryLink);
    expect(await categorizeFsMutation("write", [join(ws, "alias", "project.json")], o())).toBe("trust_config");
  });

  it("trashing or extracting over a folder that holds .atomic is trust_config", async () => {
    expect(await categorizeFsMutation("trash", [ws], o())).toBe("trust_config");
    expect(await categorizeFsMutation("extract", [ws], o())).toBe("trust_config");
  });

  it.runIf(process.platform === "win32" || process.platform === "darwin")("matches .ATOMIC case-insensitively where the disk does", async () => {
    expect(await categorizeFsMutation("write", [join(ws, ".ATOMIC", "Project", "project.json")], o())).toBe("trust_config");
  });
});

