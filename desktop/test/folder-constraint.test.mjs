// Review of issue #67 (third round), item 6: the provisional "restricted
// to: …" chip matched a new chat's folder against projects.constraints
// lexically in the window, while the agent also matches real paths (a link),
// linked git worktrees and `..`. Main now answers with a port of the agent's
// resolveProjectConstraint (main/folder-constraint.ts, IPC
// agent:folderConstraint); this test runs the port and the agent's own code
// on the same cases, so the two cannot drift.
// Run: npm run build first (the main half is read from out/).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { loadCore } from "./core-ts.mjs";

const require = createRequire(import.meta.url);
const M = require("../out/main/folder-constraint.js");
const core = loadCore(new URL("../../src/config/project-constraint-match.ts", import.meta.url), ["node:fs"]);
const coreAnswer = (constraints, dir, opts) => {
  const p = core.resolveProjectConstraint({ projects: { constraints } }, dir, opts);
  return p === undefined ? null : { key: p.key, allowedProviders: [...p.allowedProviders], allowedEgress: [...p.allowedEgress] };
};
const same = (constraints, dir, opts) => {
  const mine = M.folderConstraintFor(constraints, dir, opts);
  assert.deepEqual(mine, coreAnswer(constraints, dir, opts), JSON.stringify({ dir, platform: opts && opts.platform }));
  return mine;
};

test("the port answers as the agent does on lexical, link and worktree cases on each platform", () => {
  const W = { "C:\\Users\\me\\Downloads\\riservata": { allowedProviders: ["local-llama"], allowedEgress: ["git"] },
    "C:\\Users\\me\\Downloads\\riservata\\deeper": { allowedProviders: [] }, "D:\\linked-target": { allowedProviders: ["local-llama"] } };
  const winLinks = (p) => (/^c:\\users\\me\\links\\ris/i.test(p) ? p.replace(/^c:\\users\\me\\links\\ris/i, "C:\\Users\\me\\Downloads\\riservata") : /^E:\\lnk/i.test(p) ? p.replace(/^E:\\lnk/i, "D:\\linked-target") : undefined);
  const winTree = (p) => (/^F:\\wt/i.test(p) ? p.replace(/^F:\\wt/i, "C:\\Users\\me\\Downloads\\riservata") : undefined);
  for (const dir of ["C:\\Users\\me\\Downloads\\riservata", "c:/users/ME/downloads/Riservata/notes", "C:\\Users\\me\\Downloads\\riservata-other",
    "C:\\Users\\me\\Downloads\\riservata\\deeper\\x", "C:\\Users\\me\\Downloads\\riservata\\..\\eis", "C:\\Users\\me\\links\\ris\\sub",
    "E:\\lnk\\new\\folder", "F:\\wt\\src", "\\\\?\\C:\\Users\\me\\Downloads\\riservata", "C:\\eis", ""]) {
    same(W, dir, { platform: "win32", realpath: winLinks, worktreeSource: winTree });
  }
  const P = { "/work/client": { allowedProviders: ["local-llama"] }, "/Work/Client/inner": { allowedProviders: ["x"] } };
  for (const platform of ["linux", "darwin"]) {
    for (const dir of ["/work/client", "/work/client/a", "/work/clientele", "/work/other/../client/b", "/Work/Client/inner/z", "/links/c", "/wt/a", "/"]) {
      same(P, dir, { platform, realpath: (p) => (p.startsWith("/links/c") ? p.replace("/links/c", "/work/client") : undefined),
        worktreeSource: (p) => (p.startsWith("/wt") ? p.replace("/wt", "/work/client") : undefined) });
    }
  }
  assert.equal(M.folderConstraintFor(undefined, "/x"), null);
  assert.equal(M.folderConstraintFor({}, "/x"), null);
});

const tmp = mkdtempSync(join(tmpdir(), "desktop-folder-constraint-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("on this computer's disk, a link and a linked worktree resolve as the agent resolves them", () => {
  const repo = join(tmp, "repo");
  mkdirSync(join(repo, ".git", "worktrees", "wt"), { recursive: true });
  const wt = join(tmp, "wt");
  mkdirSync(join(wt, "src"), { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
  const link = join(tmp, "link");
  try { symlinkSync(repo, link, "dir"); } catch { /* no links here (Windows without the right): the rest still runs */ }
  const constraints = { [repo]: { allowedProviders: ["local-llama"] } };
  assert.equal(same(constraints, join(wt, "src")).key, repo, "the worktree stands for its repository");
  same(constraints, join(link, "not", "yet"));
  same(constraints, join(tmp, "elsewhere"));
});

test("main answers the window through agent:folderConstraint, with its config and never for a remote agent", () => {
  const live = readFileSync(new URL("../main/agent-live.ts", import.meta.url), "utf8");
  assert.match(live, /ipcMain\.handle\("agent:folderConstraint"/);
  assert.match(live, /if \(client\.isRemote\) return \{ known: false, constraint: null \};/);
  assert.match(readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8"), /folderConstraint: \(dir: string\) => ipcRenderer\.invoke\("agent:folderConstraint", dir\)/);
});
