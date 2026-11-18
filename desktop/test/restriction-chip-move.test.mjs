// Review of issue #67 (third round), item 4: moving the open chat to another
// folder with the workspace chip (a live move, ATO-731) did not ask about
// its restriction again, so a chat moved into a restricted folder had no
// chip until a turn ended, and one moved out kept a stale one. The move now
// asks the agent for the chat on screen. applyWorkspaceChoice and
// chat-restriction.js in a vm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const renderer = src("../renderer/renderer.js");
function fn(name) {
  const at = renderer.indexOf("\nfunction " + name + "(");
  if (at < 0) throw new Error("no function " + name);
  return renderer.slice(at + 1, renderer.indexOf("\n}\n", at) + 2);
}
const RIS = "C:\\Users\\edoar\\Downloads\\riservata";
const AGENT = { known: true, channelsAllowed: false, remote: false, status: 200,
  restriction: { label: "restricted to: local-llama", allowedProviders: ["local-llama"], folder: RIS, readFrom: [] } };
const FREE = { known: true, channelsAllowed: true, remote: false, status: 200, restriction: null };

function windowWith(answers) {
  const asked = [];
  const c = vm.createContext({
    S: { sessionId: "s-1", agentSession: "s-1", room: "chat", log: [] }, SK: {}, WORKSPACE: "C:\\eis",
    esc: (s) => String(s), ic: () => "", providerWord: (x) => x, rmNow: () => ({ effective: "local" }),
    document: { querySelector: () => null }, setTimeout: () => 0, render: () => {}, nid: () => "n", toast: () => {}, restartRefusedToast: () => {}, restartStopsTurn: () => null,
    ProjectModels: { noteChatFolder: () => {}, state: { chats: {} } },
    BR: { providerRestriction: async (sid) => { asked.push(sid); return answers.shift(); } },
  });
  vm.runInContext(src("../renderer/chat-restriction.js"), c);
  vm.runInContext(fn("applyWorkspaceChoice"), c);
  return { c, asked };
}
const settle = () => new Promise((r) => setImmediate(r));

test("moving the open chat into a restricted folder brings the chip, and out of it takes it away", async () => {
  const { c, asked } = windowWith([AGENT, FREE]);
  c.applyWorkspaceChoice({ live: true, dir: RIS });
  await settle();
  assert.deepEqual([...asked], ["s-1"]);
  assert.match(c.restrictionChipHTML(), /restricted to: local-llama/);
  c.applyWorkspaceChoice({ live: true, dir: "C:\\open" });
  await settle();
  assert.equal(asked.length, 2);
  assert.equal(c.restrictionChipHTML(), "");
});

test("a pick that only changes the folder for new chats asks nothing", async () => {
  const { c, asked } = windowWith([AGENT]);
  c.S.agentSession = null;
  c.applyWorkspaceChoice({ live: true, dir: RIS });
  c.applyWorkspaceChoice({ live: false, busy: true });
  await settle();
  assert.equal(asked.length, 0);
});
