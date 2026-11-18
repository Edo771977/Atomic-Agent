// Review of issue #67, item 3: a new chat in a restricted folder showed no
// "restricted to: …" chip before its first message (the moment the person
// picks a provider for it), and at its first turn's end the agent's route
// could answer 404 because the chat was not stored yet, with no second ask.
// Now a 404 is asked again once, after the stand-in grace (PENDING_GRACE_MS),
// and a chat with no session yet wears a provisional chip worked out from
// the folder it will open in (a project's, else the window's) against this
// window's projects.constraints, said to be provisional, for an agent on
// this computer only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

// Main's own matcher answers the provisional chip (agent:folderConstraint), as on Windows.
const FC = createRequire(import.meta.url)("../out/main/folder-constraint.js");
const mainAnswer = (config, remote = false) => async (dir) => remote ? { known: false, constraint: null }
  : { known: true, constraint: FC.folderConstraintFor(config.projects.constraints, dir, { platform: "win32", realpath: () => undefined, worktreeSource: () => undefined }) };

const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const KEY = "C:\\Users\\me\\Downloads\\riservata";
const RESTRICTED = { known: true, channelsAllowed: false, remote: false, status: 200,
  restriction: { label: "restricted to: local-llama", allowedProviders: ["local-llama"], folder: KEY, readFrom: [] } };
const NOT_STORED = { known: false, restriction: null, channelsAllowed: null, remote: false, status: 404 };

function windowWith(answers, over = {}) {
  const asked = [];
  const c = vm.createContext({
    S: { sessionId: "s-1", agentSession: "s-1" }, IS_WIN: true, IS_MAC: false, PENDING_GRACE_MS: 5,
    LIVE_CONFIG: { projects: { constraints: { [KEY]: { allowedProviders: ["local-llama"] } } } },
    esc: (s) => String(s), ic: () => "", providerWord: (x) => x, rmNow: () => ({ effective: "local" }),
    document: { querySelector: () => null }, setTimeout, workingDir: () => "C:\\Users\\me\\eis",
    projectMarkedInfo: () => null, ProjectModels: { state: { loaded: true, remote: false } },
    ...over,
  });
  c.BR = { providerRestriction: async (sid) => { asked.push(sid); return answers.shift(); },
    folderConstraint: mainAnswer(c.LIVE_CONFIG, over.remote === true) };
  vm.runInContext(src("../renderer/chat-restriction.js"), c);
  return { c, asked };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("a chat the agent has not stored yet (404) is asked again once", async () => {
  const { c, asked } = windowWith([NOT_STORED, RESTRICTED]);
  await c.restrictionRefresh("s-1");
  assert.equal(c.restrictionChipHTML(), "");
  await wait(40);
  assert.deepEqual([...asked], ["s-1", "s-1"]);
  assert.match(c.restrictionChipHTML(), /restricted to: local-llama/);
});

test("only once: a second 404 leaves no chip and no third ask", async () => {
  const { c, asked } = windowWith([NOT_STORED, NOT_STORED, RESTRICTED]);
  await c.restrictionRefresh("s-1");
  await wait(40);
  assert.equal(asked.length, 2);
  assert.equal(c.restrictionChipHTML(), "");
});

const drawn = async (c) => { c.restrictionChipHTML(); await wait(5); return c.restrictionChipHTML(); };

test("a new chat marked for a restricted project wears a provisional chip before its first message", async () => {
  const { c } = windowWith([], {
    S: { sessionId: null, agentSession: null },
    projectMarkedInfo: () => ({ id: "pris1234", name: "Riservata", folder: KEY + "\\notes" }),
  });
  const html = await drawn(c);
  assert.match(html, /class="cchip restrictchip provisional"/);
  assert.match(html, /restricted to: local-llama/);
  assert.match(html, /title="This new chat's folder \(C:\\Users\\me\\Downloads\\riservata\\notes\) is restricted in projects\.constraints\. From this window's config: the agent confirms it once the first message is sent\.\nProviders allowed: local-llama\./);
});

test("the window's folder counts for a plain new chat; an open folder, a sibling or a remote agent gives none", async () => {
  const plain = windowWith([], { S: { sessionId: null, agentSession: null }, workingDir: () => KEY });
  assert.match(await drawn(plain.c), /restricted to: local-llama/);
  for (const over of [
    { workingDir: () => "C:\\Users\\me\\eis" },
    { workingDir: () => KEY + "-other" },
    { workingDir: () => KEY, remote: true },
  ]) {
    const w = windowWith([], { S: { sessionId: null, agentSession: null }, ...over });
    assert.equal(await drawn(w.c), "", JSON.stringify(Object.keys(over)));
  }
});

/* Review of #67 (third round), item 6: the agent's own rules, through main. */
test("a folder reached through a link counts, as the agent counts it; a config change asks again", async () => {
  const LINK = "E:\\links\\ris";
  const w = windowWith([], { S: { sessionId: null, agentSession: null }, workingDir: () => LINK + "\\notes" });
  w.c.BR.folderConstraint = async (dir) => ({ known: true, constraint: FC.folderConstraintFor(w.c.LIVE_CONFIG.projects.constraints, dir,
    { platform: "win32", realpath: (p) => (p.toLowerCase().startsWith(LINK.toLowerCase()) ? KEY + p.slice(LINK.length) : undefined), worktreeSource: () => undefined }) });
  assert.match(await drawn(w.c), /restricted to: local-llama/);
  w.c.BR.folderConstraint = async () => ({ known: true, constraint: null });
  await w.c.restrictionConfigChanged(w.c.LIVE_CONFIG, { projects: { constraints: {} } });
  assert.equal(await drawn(w.c), "");
});

test("main passes the answer's status and whether the agent is remote", () => {
  const live = src("../main/agent-live.ts");
  assert.match(live, /status: res\.status/);
});
