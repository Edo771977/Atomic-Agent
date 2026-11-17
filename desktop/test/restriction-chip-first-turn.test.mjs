// Review of issue #67 (third round), item 3: once the stream named a new
// chat's session (S.agentSession set mid first turn), the chip wanted the
// agent's answer for that id, which had not been asked (and is a 404 until
// the agent stores the turn): no chip for the rest of the first turn. The
// window now asks when the session is named, and until the agent has
// answered for a chat it has not stored yet, the provisional chip stays.
// A stored chat the agent does not answer for (an older agent) still has none:
// only a chat with item 27's pending row (named, not stored) gets one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

// Main's own matcher answers the provisional chip (agent:folderConstraint), as on Windows.
const FC = createRequire(import.meta.url)("../out/main/folder-constraint.js");
const folderConstraint = (constraints) => async (dir) => ({ known: true,
  constraint: FC.folderConstraintFor(constraints, dir, { platform: "win32", realpath: () => undefined, worktreeSource: () => undefined }) });
const settle = () => new Promise((r) => setImmediate(r));

const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const RIS = "C:\\Users\\edoar\\Downloads\\riservata";
const NOT_STORED = { known: false, restriction: null, channelsAllowed: null, remote: false, status: 404 };
const AGENT = { known: true, channelsAllowed: false, remote: false, status: 200,
  restriction: { label: "restricted to: local-llama", allowedProviders: ["local-llama"], folder: RIS, readFrom: [] } };

function windowWith(answers) {
  const asked = [];
  const c = vm.createContext({
    S: { sessionId: "s-1", agentSession: "s-1", room: "chat" }, IS_WIN: true, IS_MAC: false, PENDING_GRACE_MS: 1e6,
    LIVE_CONFIG: { projects: { constraints: { [RIS]: { allowedProviders: ["local-llama"] } } } },
    SESSIONS: [], PENDING_CHATS: new Map([["s-1", { id: "s-1", pending: true }]]), esc: (s) => String(s), ic: () => "", providerWord: (x) => x, rmNow: () => ({ effective: "local" }),
    document: { querySelector: () => null }, setTimeout: () => 0, chatWorkingDir: () => RIS, workingDir: () => "C:\\eis",
    ProjectModels: { state: { loaded: true, remote: false } },
    BR: { providerRestriction: async (sid) => { asked.push(sid); return answers.shift(); },
      folderConstraint: folderConstraint({ [RIS]: { allowedProviders: ["local-llama"] } }) },
  });
  vm.runInContext(src("../renderer/chat-restriction.js"), c);
  return { c, asked };
}

test("a chat named mid first turn keeps its provisional chip until the agent answers for it", async () => {
  const { c } = windowWith([NOT_STORED, AGENT]);
  c.restrictionChipHTML(); await settle();
  assert.match(c.restrictionChipHTML(), /restrictchip provisional/, "before any answer");
  await c.restrictionRefresh("s-1");
  assert.match(c.restrictionChipHTML(), /restrictchip provisional/, "the agent has not stored it yet");
  await c.restrictionRefresh("s-1");
  assert.match(c.restrictionChipHTML(), /class="cchip restrictchip" /, "the agent's own answer");
});

test("a stored chat the agent gives no answer for has no chip", async () => {
  const { c } = windowWith([NOT_STORED]);
  c.SESSIONS.push({ id: "s-1", workingDir: RIS });
  c.PENDING_CHATS.clear();
  await c.restrictionRefresh("s-1");
  assert.equal(c.restrictionChipHTML(), "");
});

test("the window asks when the stream names the session of the chat on screen", () => {
  const r = src("../renderer/renderer.js");
  const at = r.indexOf("  if (ev.kind === 'session_id') {\n    // item 6");
  assert.match(r.slice(at, at + 1600), /void restrictionRefresh\(S\.agentSession\);/);
});
