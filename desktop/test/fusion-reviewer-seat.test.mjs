// Issue #71: the Fusion strip's third seat, the Reviewer. The agent lists
// the team with what can serve the chat (GET /api/fusion/team, read by
// main/fusion-team.ts); the seat offers the usable reviewers, "No review",
// and "Add a reviewer…", which writes llm.runMode.fusion.team.reviewers
// through the config lock (creating the team from the two seats when there
// is none, so nothing else changes). The chat's choice rides on its next
// turn as `reviewer`, which the agent stamps and keeps; the Director and
// Worker seats stay the two legs, sent as `director` / `worker` when the
// team lists them and the chat's folder allows them.
// Run: npm run build first (the main half is read from out/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const M = require("../out/main/fusion-team.js");
const R = require("../renderer/fusion-reviewer.js");
const { AgentClient } = require("../out/main/agent-client.js");

const member = (ref, extra = {}) => {
  const at = ref.indexOf(":");
  return { ref, providerId: ref.slice(0, at), model: ref.slice(at + 1), usable: true, ...extra };
};
const ROSTER_BODY = {
  configured: true, mode: "fusion",
  directors: [member("anthropic:model-a")],
  workers: [member("local-llama:local-llama")],
  reviewers: [member("codex-cli:default"), member("openrouter:model-o", { usable: false, reason: "folder", why: "this folder (/w) does not allow openrouter" }),
    member("codex-b:default", { usable: false, reason: "cli-tools", why: "codex-b keeps its own read-only shell, which can read outside this restricted folder" })],
  review: "on", restriction: null,
  chat: { session_id: "s1", director: "anthropic:model-a", worker: null, reviewer: null },
};
const providers = [
  { id: "local-llama", kind: "llama-server" },
  { id: "anthropic", kind: "anthropic", defaultChatModel: "model-a" },
  { id: "codex-cli", kind: "subscription-cli", subscriptionCli: { cli: "codex" }, defaultChatModel: "" },
  { id: "openrouter", kind: "openrouter", defaultChatModel: "model-o" },
  { id: "lmstudio", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", defaultChatModel: "m" },
];
const config = (team) => ({
  llm: {
    providers: JSON.parse(JSON.stringify(providers)),
    runMode: { mode: "fusion", fusion: { orchestratorProvider: "anthropic", workerProvider: "local-llama", ...(team ? { team } : {}) } },
  },
});

test("main reads the agent's team answer, and nothing from an older agent", () => {
  const read = M.readFusionTeam({ status: 200, body: ROSTER_BODY });
  assert.equal(read.known, true);
  assert.equal(read.configured, true);
  assert.deepEqual(read.reviewers.map((r) => [r.ref, r.usable, r.why ?? null]),
    [["codex-cli:default", true, null], ["openrouter:model-o", false, "this folder (/w) does not allow openrouter"],
      ["codex-b:default", false, "codex-b keeps its own read-only shell, which can read outside this restricted folder"]]);
  assert.deepEqual(read.chat, { director: "anthropic:model-a", worker: null, reviewer: null });
  for (const answer of [null, { status: 404, body: null }, { status: 200, body: { configured: "yes" } }]) {
    assert.equal(M.readFusionTeam(answer).known, false, JSON.stringify(answer));
  }
});

test("Add a reviewer creates the team from the director seat, without workers, review off for other chats", () => {
  const cfg = config();
  const before = JSON.parse(JSON.stringify(cfg));
  const plan = M.planAddReviewer(cfg, "codex-cli:default");
  assert.equal(plan.write, true);
  // No `workers`: the worker leg and fusion.roles keep routing as before. `review: "off"`: only a chat
  // that picks a reviewer is reviewed (the agent turns review on for that chat).
  assert.deepEqual(plan.team, { directors: ["anthropic:model-a"], reviewers: ["codex-cli:default"], review: "off" });
  assert.deepEqual(plan.legs, { director: "anthropic:model-a" });
  assert.deepEqual(cfg.llm.runMode.fusion.team, plan.team);
  delete cfg.llm.runMode.fusion.team;
  assert.deepEqual(cfg, before);
});

test("Add a reviewer: the first one in a team turns review off unless it is on; later ones change nothing else", () => {
  const plain = config({ directors: ["anthropic:model-a"] });
  assert.equal(M.planAddReviewer(plain, "codex-cli:default").team.review, "off");
  const on = config({ directors: ["anthropic:model-a"], review: "on" });
  assert.equal(M.planAddReviewer(on, "codex-cli:default").team.review, "on");
  const cfg = config({ directors: ["anthropic:model-a"], reviewers: ["openrouter:model-o"] });
  const plan = M.planAddReviewer(cfg, "codex-cli:default");
  assert.deepEqual(plan.team, { directors: ["anthropic:model-a"], reviewers: ["openrouter:model-o", "codex-cli:default"] });
  assert.equal(M.planAddReviewer(cfg, "codex-cli:default").write, false);
  assert.match(M.planAddReviewer(config(), "nobody:model").error, /not a configured provider/);
  assert.match(M.planAddReviewer(config(), "no-model").error, /<providerId>:<model>/);
});

test("\"default\" is a subscription CLI's own model only; an API entry with no model is refused with a hint", () => {
  assert.match(M.planAddReviewer(config(), "openrouter:default").error, /name a model/);
  const bare = config();
  bare.llm.providers.push({ id: "bare", kind: "openai-compatible", baseUrl: "https://bare.example/v1" });
  bare.llm.runMode.fusion.orchestratorProvider = "bare";
  assert.equal(M.legRef(bare, "orchestrator"), null);
  assert.match(M.planAddReviewer(bare, "codex-cli:default").error, /pick a model for the Director seat/);
  assert.equal(M.legRef(config(), "worker"), "local-llama:local-llama");
});

test("a moved seat replaces the member the desktop added for it, in place; one removed by hand is not re-added", () => {
  const cfg = config({ directors: ["x-user:model", "anthropic:model-a"], reviewers: ["codex-cli:default"] });
  const last = { director: "anthropic:model-a" };
  assert.equal(M.planFollowLegs(cfg, last).write, false);
  cfg.llm.runMode.fusion.orchestratorProvider = "openrouter";
  const plan = M.planFollowLegs(cfg, last);
  assert.equal(plan.write, true);
  assert.deepEqual(plan.team.directors, ["x-user:model", "openrouter:model-o"]);
  assert.deepEqual(plan.legs, { director: "openrouter:model-o" });
  // The person removed the desktop's entry by hand: only the current leg is added, at the end.
  const removed = config({ directors: ["x-user:model"] });
  removed.llm.runMode.fusion.orchestratorProvider = "openrouter";
  assert.deepEqual(M.planFollowLegs(removed, { director: "anthropic:model-a" }).team.directors, ["x-user:model", "openrouter:model-o"]);
  // Never more than 8 directors.
  const full = config({ directors: Array.from({ length: 8 }, (_, n) => `anthropic:m${n}`) });
  assert.equal(M.planFollowLegs(full, {}).write, false);
  assert.equal(M.planFollowLegs(config(), {}).write, false);
});

test("a turn names the seats' members the chat can use, and the chat's reviewer", () => {
  const cfg = config({ directors: ["anthropic:model-a"], workers: ["local-llama:local-llama"], reviewers: ["codex-cli:default"] });
  const roster = M.readFusionTeam({ status: 200, body: ROSTER_BODY });
  assert.deepEqual(M.turnTeamFields(cfg, roster, "codex-cli:default"),
    { director: "anthropic:model-a", worker: "local-llama:local-llama", reviewer: "codex-cli:default" });
  assert.deepEqual(M.turnTeamFields(cfg, roster, "none"), { director: "anthropic:model-a", worker: "local-llama:local-llama", reviewer: "none" });
  // A seat the folder refuses is not named: the agent then runs Fusion as the folder allows.
  const refused = M.readFusionTeam({ status: 200, body: { ...ROSTER_BODY, directors: [member("anthropic:model-a", { usable: false, reason: "folder", why: "x" })] } });
  assert.deepEqual(M.turnTeamFields(cfg, refused, undefined), { worker: "local-llama:local-llama" });
  // No team, or another route: nothing, so a setup without a team works as before.
  assert.deepEqual(M.turnTeamFields(config(), roster, "codex-cli:default"), {});
  const cloud = config({ directors: ["anthropic:model-a"] });
  cloud.llm.runMode.mode = "cloud";
  assert.deepEqual(M.turnTeamFields(cloud, roster, "none"), {});
  assert.deepEqual(M.teamChoiceFromWindow({ reviewer: "codex-cli:default" }), { reviewer: "codex-cli:default" });
  assert.deepEqual(M.teamChoiceFromWindow({ reviewer: "none" }), { reviewer: "none" });
  assert.deepEqual(M.teamChoiceFromWindow({ reviewer: "team" }), { reviewer: "team" });
  assert.deepEqual(M.teamChoiceFromWindow({ reviewer: "bad" }), {});
  assert.deepEqual(M.teamChoiceFromWindow(null), {});
});

test("client: the turn carries director, worker and reviewer; the team is read from /api/fusion/team", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ url: req.url, body });
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end("data: [DONE]\n\n");
        return;
      }
      if (req.url === "/api/fusion/team?session=s1") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(ROSTER_BODY));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new AgentClient(process.cwd());
  client.port = server.address().port;
  client.token = "t0ken";
  try {
    await client.chat("turn-1", [{ role: "user", content: "hi" }], "chat-1", undefined, undefined, undefined, undefined,
      { director: "anthropic:model-a", reviewer: "none" });
    const turn = JSON.parse(seen.find((r) => r.url === "/v1/chat/completions").body);
    assert.equal(turn.director, "anthropic:model-a");
    assert.equal(turn.reviewer, "none");
    assert.equal("worker" in turn, false);
    const answer = await client.fusionTeam("s1");
    assert.equal(answer.status, 200);
    assert.equal(M.readFusionTeam(answer).reviewers.length, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

const word = (id) => ({ "codex-cli": "Codex", openrouter: "OpenRouter", anthropic: "Anthropic" }[id] || id);

test("the Reviewer seat lists the usable reviewers, the others disabled with why, No review and Add a reviewer", () => {
  const roster = M.readFusionTeam({ status: 200, body: ROSTER_BODY });
  const rows = R.fzrRows(roster, null, word);
  assert.deepEqual(rows.map((r) => [r.kind, r.ref ?? null, r.disabled === true, r.active === true]), [
    ["auto", null, false, true],
    ["member", "codex-cli:default", false, false],
    ["member", "openrouter:model-o", true, false],
    ["member", "codex-b:default", true, false],
    ["none", null, false, false],
    ["add", null, false, false],
  ]);
  assert.equal(rows[2].detail, "this folder (/w) does not allow openrouter");
  assert.equal(rows[3].detail, "codex-b keeps its own read-only shell, which can read outside this restricted folder");
  assert.equal(M.readFusionTeam({ status: 200, body: ROSTER_BODY }).reviewers[2].reason, "cli-tools");
  assert.equal(rows[1].label, "Codex");
  assert.equal(R.fzrSeatWord(roster, null, word), "Team picks");
  assert.equal(R.fzrSeatWord(roster, "none", word), "No review");
  assert.equal(R.fzrSeatWord(roster, "codex-cli:default", word), "Codex");
  assert.equal(R.fzrSeatWord(roster, "openrouter:model-o", word), "OpenRouter · model-o");
  // No team: the seat still offers to add a reviewer; a choice there is never sent.
  const none = M.readFusionTeam({ status: 200, body: { configured: false, mode: "fusion", directors: [], workers: [], reviewers: [], review: null, restriction: null } });
  assert.deepEqual(R.fzrRows(none, null, word).map((r) => r.kind), ["empty", "add"]);
  assert.equal(R.fzrSeatWord(none, null, word), "No reviewer");
  // The chat's own choice is the one marked.
  assert.equal(R.fzrRows(roster, "none", word).find((r) => r.kind === "none").active, true);
});

test("Add a reviewer lists the configured cloud providers, a Codex subscription first, or the way to add one", () => {
  const roster = M.readFusionTeam({ status: 200, body: { ...ROSTER_BODY, reviewers: [] } });
  const list = R.fzrCandidates({ llm: { providers } }, roster, word);
  assert.deepEqual(list.map((c) => c.ref), ["codex-cli:default", "anthropic:model-a", "openrouter:model-o"]);
  assert.match(list[0].detail, /ChatGPT subscription.*read-only/);
  // Already a reviewer: not offered again.
  assert.deepEqual(R.fzrCandidates({ llm: { providers } }, M.readFusionTeam({ status: 200, body: ROSTER_BODY }), word).map((c) => c.ref),
    ["anthropic:model-a"]);
  assert.deepEqual(R.fzrCandidates({ llm: { providers: [providers[0]] } }, roster, word), []);
  assert.match(R.FZR_ADD_HINT, /Settings › Models/);
  assert.match(R.FZR_ADD_HINT, /Codex/);
});

test("the strip draws the Reviewer seat after the Worker seat", () => {
  const renderer = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  const at = renderer.indexOf("\nfunction fzChipsHtml(");
  const body = renderer.slice(at, renderer.indexOf("\n}\n", at));
  assert.match(body, /fzrSeatHTML\(\)/);
  assert.ok(body.indexOf("fzrSeatHTML()") > body.indexOf("workerschip"));
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('src="fusion-reviewer.js"') >= 0 && html.indexOf('src="fusion-reviewer.js"') < html.indexOf('src="renderer.js"'));
});

function seatContext(roster, writes) {
  const ctx = {
    S: { agentSession: "s1", sessionId: "s1", overlay: null },
    LIVE_CONFIG: { llm: { providers, runMode: { mode: "fusion", fusion: { orchestratorProvider: "anthropic", workerProvider: "local-llama" } } } },
    BR: {
      fusionTeam: async () => roster,
      fusionTeamWrite: async (payload) => { writes.push(payload); return { ok: true, changed: true, live: true }; },
    },
    esc: (s) => String(s), ic: () => "", providerWord: word, render: () => {}, toast: () => {},
    refreshLiveConfig: async () => {}, document: undefined,
  };
  vm.runInNewContext(readFileSync(new URL("../renderer/fusion-reviewer.js", import.meta.url), "utf8"), ctx);
  return ctx;
}

test("window: a pick rides on every turn until the agent's stamp shows it; a refusal keeps it and says why", async () => {
  const writes = [];
  let roster = M.readFusionTeam({ status: 200, body: ROSTER_BODY });
  const c = seatContext(null, writes);
  c.BR.fusionTeam = async () => roster;
  await c.fzrRefresh("s1");
  assert.match(c.fzrSeatHTML(), /Team picks/);
  await c.fzrAct("pick:none");
  assert.match(c.fzrSeatHTML(), /No review/);
  assert.deepEqual({ ...c.fzrTurnTeam("s1") }, { reviewer: "none" });
  // The agent refused the turn (say, the folder): the choice stays, with the agent's words on the seat.
  await c.fzrTurnEnded("s1", "provider not allowed here");
  assert.deepEqual({ ...c.fzrTurnTeam("s1") }, { reviewer: "none" });
  assert.match(c.fzrSeatHTML(), /Not applied yet: provider not allowed here/);
  // The agent stamped it: the pick is used up, and the seat reads the stamp.
  roster = M.readFusionTeam({ status: 200, body: { ...ROSTER_BODY, chat: { ...ROSTER_BODY.chat, reviewer: "none" } } });
  await c.fzrTurnEnded("s1", null);
  assert.equal(c.fzrTurnTeam("s1"), null);
  assert.match(c.fzrSeatHTML(), /No review/);
  // Team picks clears the stamp: sent as "team" until the agent's answer has none.
  await c.fzrAct("pick:");
  assert.deepEqual({ ...c.fzrTurnTeam("s1") }, { reviewer: "team" });
  assert.match(c.fzrSeatHTML(), /Team picks/);
  roster = M.readFusionTeam({ status: 200, body: ROSTER_BODY });
  await c.fzrTurnEnded("s1", null);
  assert.equal(c.fzrTurnTeam("s1"), null);
  await c.fzrAct("add:anthropic:model-a");
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [{ op: "addReviewer", ref: "anthropic:model-a" }]);
  assert.deepEqual({ ...c.fzrTurnTeam("s1") }, { reviewer: "anthropic:model-a" });
  // A leg moved with a team in the config: the team follows it.
  c.LIVE_CONFIG.llm.runMode.fusion.team = { directors: ["anthropic:model-a"] };
  await c.fzrLegsMoved();
  assert.deepEqual({ ...writes.at(-1) }, { op: "followLegs" });
});

test("window: a new chat's pick moves to the chat once the agent names it", async () => {
  const c = seatContext(M.readFusionTeam({ status: 200, body: ROSTER_BODY }), []);
  c.S.agentSession = null;
  await c.fzrAct("pick:codex-cli:default");
  assert.deepEqual({ ...c.fzrTurnTeam(undefined) }, { reviewer: "codex-cli:default" });
  c.fzrTurnSent(undefined, "t1", { reviewer: "codex-cli:default" });
  if (typeof c.fzrTurnNamed === "function") c.fzrTurnNamed("t1", "s9");
  c.S.agentSession = "s9";
  await c.fzrRefresh("s9");
  assert.deepEqual({ ...c.fzrTurnTeam("s9") }, { reviewer: "codex-cli:default" });
  assert.equal(c.fzrTurnTeam(undefined), null);
});

// Issue #74 (14): the pick moved to whichever chat was refreshed next, so an
// unrelated chat opened before the stream named the new one was stamped with
// a reviewer nobody chose for it. The pick is the turn's now, and moves only
// when that turn's session_id frame names its chat (renderer.js firstTurnNamed).
test("window: a new chat's pick goes with its turn, never to the chat refreshed next", async () => {
  const c = seatContext(M.readFusionTeam({ status: 200, body: ROSTER_BODY }), []);
  c.S.agentSession = null;
  await c.fzrAct("pick:codex-cli:default");
  const sent = c.fzrTurnTeam(undefined);
  c.fzrTurnSent(undefined, "t1", sent);
  // The person opens chat B before the stream names the new chat.
  c.S.agentSession = "chat-B";
  await c.fzrRefresh("chat-B");
  assert.equal(c.fzrTurnTeam("chat-B"), null, "chat B carries a reviewer nobody picked for it");
  // Another new chat starts from the team's choice, not the first one's pick.
  assert.equal(c.fzrTurnTeam(undefined), null);
  // The stream names the first turn's chat: the pick is that chat's.
  c.fzrTurnNamed("t1", "s9");
  assert.deepEqual({ ...c.fzrTurnTeam("s9") }, { reviewer: "codex-cli:default" });
  assert.equal(c.fzrTurnTeam("chat-B"), null);
  // A first turn that ended unnamed leaves nothing behind.
  c.S.agentSession = null;
  await c.fzrAct("pick:none");
  c.fzrTurnSent(undefined, "t2", c.fzrTurnTeam(undefined));
  c.fzrTurnNamed("t2", null);
  c.fzrTurnNamed("t3", "s10");
  assert.equal(c.fzrTurnTeam("s10"), null);
  assert.equal(vm.runInContext("JSON.stringify(FZR.byTurn)", c), "{}");
});

test("Add a reviewer: an API provider with no model is listed disabled, with where to pick one", () => {
  const roster = M.readFusionTeam({ status: 200, body: { ...ROSTER_BODY, reviewers: [] } });
  const list = R.fzrCandidates({ llm: { providers: [...providers, { id: "bare", kind: "openai-compatible", baseUrl: "https://bare.example/v1" }] } }, roster, word);
  const bare = list.find((c) => c.providerId === "bare");
  assert.equal(bare.disabled, true);
  assert.match(bare.detail, /pick a model for it in Settings › Models/);
  assert.equal(R.fzrEntryRef({ id: "openrouter", kind: "openrouter" }), null);
  assert.equal(R.fzrEntryRef({ id: "codex-cli", kind: "subscription-cli", subscriptionCli: { cli: "codex" } }), "codex-cli:default");
});

test("window: an unusable reviewer cannot be picked, and an older agent shows no seat", async () => {
  const c = seatContext(M.readFusionTeam({ status: 200, body: ROSTER_BODY }), []);
  await c.fzrRefresh("s1");
  c.S.overlay = "fzr";
  const pop = c.fzrPopoverHTML();
  assert.match(pop, /<button class="poprow dim" disabled title="this folder \(\/w\) does not allow openrouter">/);
  assert.match(pop, /data-act="fzr:pick:codex-cli:default"/);
  assert.doesNotMatch(pop, /fzr:pick:openrouter/);
  const old = seatContext(M.readFusionTeam({ status: 404, body: null }), []);
  await old.fzrRefresh("s1");
  assert.equal(old.fzrSeatHTML(), "");
});

// Issue #77: "Add a reviewer…" resolved the chat after awaiting the config
// write, so switching chats during the write gave the reviewer to the chat
// now on screen and none to the one it was added from.
function delayedWrite(c) {
  const writes = [];
  c.BR.fusionTeamWrite = (payload) => new Promise((resolve) => writes.push({ payload, done: () => resolve({ ok: true, changed: true, live: true }) }));
  return writes;
}

test("window: Add a reviewer picks it for the chat it was added from, even after a switch during the write", async () => {
  const c = seatContext(M.readFusionTeam({ status: 200, body: ROSTER_BODY }), []);
  c.S.agentSession = "chat-A";
  const writes = delayedWrite(c);
  const adding = c.fzrAct("add:anthropic:model-a");
  // The person opens chat B before the write resolves.
  c.S.agentSession = "chat-B"; c.S.sessionId = "chat-B";
  writes[0].done();
  await adding;
  assert.deepEqual({ ...c.fzrTurnTeam("chat-A") }, { reviewer: "anthropic:model-a" });
  assert.equal(c.fzrTurnTeam("chat-B"), null, "chat B got the reviewer picked in chat A");
});

test("window: Add a reviewer from a new chat stays the new chat's, or follows it once it is named", async () => {
  // From a new chat, then chat B opened: the new chat (not B) has it.
  let c = seatContext(M.readFusionTeam({ status: 200, body: ROSTER_BODY }), []);
  c.S.agentSession = null;
  let writes = delayedWrite(c);
  let adding = c.fzrAct("add:anthropic:model-a");
  c.S.agentSession = "chat-B";
  writes[0].done();
  await adding;
  assert.deepEqual({ ...c.fzrTurnTeam(undefined) }, { reviewer: "anthropic:model-a" });
  assert.equal(c.fzrTurnTeam("chat-B"), null);
  // The new chat got its id (a queued first message) during the write: that chat has it.
  c = seatContext(M.readFusionTeam({ status: 200, body: ROSTER_BODY }), []);
  c.S.agentSession = null;
  writes = delayedWrite(c);
  adding = c.fzrAct("add:anthropic:model-a");
  c.fzrAdoptNewChat("waiting-1");
  c.S.agentSession = "chat-B";
  writes[0].done();
  await adding;
  assert.deepEqual({ ...c.fzrTurnTeam("waiting-1") }, { reviewer: "anthropic:model-a" });
  assert.equal(c.fzrTurnTeam(undefined), null);
  assert.equal(c.fzrTurnTeam("chat-B"), null);
  // The new chat's first turn went out (with an earlier pick) during the write: the turn's chat has it once named.
  c = seatContext(M.readFusionTeam({ status: 200, body: ROSTER_BODY }), []);
  c.S.agentSession = null;
  await c.fzrAct("pick:none");
  writes = delayedWrite(c);
  adding = c.fzrAct("add:anthropic:model-a");
  c.fzrTurnSent(undefined, "t1", c.fzrTurnTeam(undefined));
  c.S.agentSession = "chat-B";
  writes[0].done();
  await adding;
  assert.equal(c.fzrTurnTeam(undefined), null, "the next new chat got the first one's reviewer");
  assert.equal(c.fzrTurnTeam("chat-B"), null);
  c.fzrTurnNamed("t1", "s9");
  assert.deepEqual({ ...c.fzrTurnTeam("s9") }, { reviewer: "anthropic:model-a" });
});

// Issue #77: a new chat's first turn that left without a pick during the add
// write was not told to the seat, so the reviewer stayed on the new-chat slot
// and went to the next new chat.
test("window: Add a reviewer from a new chat whose first turn leaves without a pick goes to that turn's chat", async () => {
  const c = seatContext(M.readFusionTeam({ status: 200, body: ROSTER_BODY }), []);
  c.S.agentSession = null;
  const writes = delayedWrite(c);
  const adding = c.fzrAct("add:anthropic:model-a");
  // The first turn carries no pick (none was made yet); renderer.js reports every new chat's send.
  const sent = c.fzrTurnTeam(undefined);
  assert.equal(sent, null);
  c.fzrTurnSent(undefined, "t1", sent);
  c.S.agentSession = "chat-B";
  writes[0].done();
  await adding;
  assert.equal(c.fzrTurnTeam(undefined), null, "the next new chat got the first one's reviewer");
  assert.equal(c.fzrTurnTeam("chat-B"), null);
  c.fzrTurnNamed("t1", "s9");
  assert.deepEqual({ ...c.fzrTurnTeam("s9") }, { reviewer: "anthropic:model-a" });
  assert.equal(vm.runInContext("JSON.stringify(FZR.byTurn)", c), "{}");
  // renderer.js tells the seat about a new chat's turn whether or not it carried a pick.
  const renderer = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  assert.match(renderer, /if \(res && res\.ok\) fzrTurnSent\(session, res\.turnId, teamChoice(, fzrToken)?\);/);
});

// Issue #77 review: Add a reviewer pressed after a new chat's first turn left,
// before its stream named the chat, went to the next new chat.
test("window: Add a reviewer on a new chat whose first turn is still unnamed goes to that turn's chat", async () => {
  const c = seatContext(M.readFusionTeam({ status: 200, body: ROSTER_BODY }), []);
  c.S.agentSession = null;
  // renderer.js: the turn the screen shows, and the new chats' first turns not named yet.
  c.FIRST_TURNS = new Map([["t1", "hello"]]);
  c.screenTurnId = () => "t1";
  c.fzrTurnSent(undefined, "t1", null);
  const writes = delayedWrite(c);
  const adding = c.fzrAct("add:anthropic:model-a");
  c.S.agentSession = "chat-B"; c.screenTurnId = () => null;
  writes[0].done();
  await adding;
  assert.equal(c.fzrTurnTeam(undefined), null, "the next new chat got the reviewer");
  assert.equal(c.fzrTurnTeam("chat-B"), null);
  c.FIRST_TURNS.delete("t1");
  c.fzrTurnNamed("t1", "s9");
  assert.deepEqual({ ...c.fzrTurnTeam("s9") }, { reviewer: "anthropic:model-a" });
  // A screen turn that is not a new chat's unnamed first turn leaves the add on the new-chat slot.
  const d = seatContext(M.readFusionTeam({ status: 200, body: ROSTER_BODY }), []);
  d.S.agentSession = null;
  d.FIRST_TURNS = new Map();
  d.screenTurnId = () => "t2";
  await d.fzrAct("add:anthropic:model-a");
  assert.deepEqual({ ...d.fzrTurnTeam(undefined) }, { reviewer: "anthropic:model-a" });
  // The renderer.js globals the seat reads.
  const renderer = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  assert.match(renderer, /\nfunction screenTurnId\(\) \{/);
  assert.match(renderer, /\nconst FIRST_TURNS = new Map\(\);/);
});

// Issue #77 review: an add that failed after the person opened another chat
// left the add popover open there, with a toast that did not say which chat.
test("window: a failed add after a switch closes its own popover and names its chat, and leaves the other chat's alone", async () => {
  const setup = () => {
    const c = seatContext(M.readFusionTeam({ status: 200, body: ROSTER_BODY }), []);
    c.S.agentSession = "chat-A";
    c.toasts = [];
    c.toast = (...a) => c.toasts.push(a);
    c.chatById = (id) => ({ "chat-A": { id, t: "Plan the trip" }, "chat-B": { id, t: "Other" } })[id] || null;
    const writes = [];
    c.BR.fusionTeamWrite = () => new Promise((resolve) => writes.push(() => resolve({ ok: false, error: "disk full" })));
    return { c, writes };
  };
  // Switched to B with A's popover still up: it closes, and the toast names A.
  let { c, writes } = setup();
  await c.fzrAct("addOpen");
  let adding = c.fzrAct("add:anthropic:model-a");
  c.S.agentSession = "chat-B";
  writes[0]();
  await adding;
  assert.equal(c.S.overlay, null, "chat A's add popover stayed open in chat B");
  assert.equal(c.toasts.length, 1);
  assert.equal(c.toasts[0][0], "Reviewer not added");
  assert.match(c.toasts[0][1], /“Plan the trip”/);
  assert.match(c.toasts[0][1], /disk full/);
  // B's own popover, opened meanwhile, stays.
  ({ c, writes } = setup());
  await c.fzrAct("addOpen");
  adding = c.fzrAct("add:anthropic:model-a");
  c.S.agentSession = "chat-B";
  await c.fzrAct("open");
  writes[0]();
  await adding;
  assert.equal(c.S.overlay, "fzr");
  // Still on A: the popover stays open to try again, and the toast is as before.
  ({ c, writes } = setup());
  await c.fzrAct("addOpen");
  adding = c.fzrAct("add:anthropic:model-a");
  writes[0]();
  await adding;
  assert.equal(c.S.overlay, "fzradd");
  assert.deepEqual([...c.toasts[0]], ["Reviewer not added", "disk full"]);
  assert.match(readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8"), /\nfunction chatById\(id\) \{/);
});

// Issue #87 (5): an add that completed between a new chat's first send and the send's acknowledgment
// (BR.chat's answer, which carries the turn id) stayed on the new-chat slot, so the next new chat got it.
// The renderer's send path, as renderer.js runs it: the choice and the dispatch, synchronously; the ack later.
function sendFirstTurn(c) {
  const teamChoice = c.fzrTurnTeam(undefined);
  const token = typeof c.fzrTurnDispatch === "function" ? c.fzrTurnDispatch(undefined) : undefined;
  return { ack: (turnId) => c.fzrTurnSent(undefined, turnId, teamChoice, token), fail: () => typeof c.fzrTurnUndispatched === "function" && c.fzrTurnUndispatched(token), teamChoice };
}
for (const [label, order, prior] of [
  ["the write ends before the ack", "write-first", null],
  ["the ack comes before the write ends", "ack-first", null],
  ["the add starts after the send, the write ends before the ack", "add-after-send", null],
  ["a pick was made before, the write ends before the ack", "write-first", "none"],
]) {
  test(`window: Add a reviewer in a new chat whose first send is not acknowledged yet (${label}) stays that chat's`, async () => {
    const c = seatContext(M.readFusionTeam({ status: 200, body: ROSTER_BODY }), []);
    c.S.agentSession = null;
    c.FIRST_TURNS = new Map();
    c.screenTurnId = () => null;
    if (prior) await c.fzrAct("pick:" + prior);
    const writes = delayedWrite(c);
    let send;
    let adding;
    if (order === "add-after-send") { send = sendFirstTurn(c); adding = c.fzrAct("add:anthropic:model-a"); }
    else { adding = c.fzrAct("add:anthropic:model-a"); send = sendFirstTurn(c); }
    if (prior) assert.deepEqual({ ...send.teamChoice }, { reviewer: prior });
    if (order === "ack-first") { send.ack("t1"); writes[0].done(); await adding; }
    else { writes[0].done(); await adding; send.ack("t1"); }
    c.FIRST_TURNS.set("t1", "hello");
    c.FIRST_TURNS.delete("t1");
    c.fzrTurnNamed("t1", "chat-A");
    c.S.agentSession = "chat-A";
    assert.deepEqual({ ...c.fzrTurnTeam("chat-A") }, { reviewer: "anthropic:model-a" }, "chat A lost the reviewer added from it");
    // The person opens new chat B.
    c.S.agentSession = null;
    assert.equal(c.fzrTurnTeam(undefined), null, "new chat B inherited chat A's reviewer");
    assert.equal(vm.runInContext("JSON.stringify(FZR.byTurn)", c), "{}");
  });
}

test("window: a new chat's first send that fails gives its pick and an add in flight back to the new-chat slot", async () => {
  const c = seatContext(M.readFusionTeam({ status: 200, body: ROSTER_BODY }), []);
  c.S.agentSession = null;
  await c.fzrAct("pick:none");
  const writes = delayedWrite(c);
  const adding = c.fzrAct("add:anthropic:model-a");
  const send = sendFirstTurn(c);
  send.fail();
  writes[0].done();
  await adding;
  assert.deepEqual({ ...c.fzrTurnTeam(undefined) }, { reviewer: "anthropic:model-a" });
  // renderer.js ties the dispatch to the send synchronously and passes the token with the ack.
  const renderer = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  const at = renderer.indexOf("const teamChoice = fzrTurnTeam(session);");
  const body = renderer.slice(at, at + 1600);
  assert.match(body, /const fzrToken = fzrTurnDispatch\(session\);/);
  assert.ok(body.indexOf("fzrTurnDispatch(session)") < body.indexOf("BR.chat("));
  assert.match(body, /fzrTurnSent\(session, res\.turnId, teamChoice, fzrToken\)/);
  assert.match(body, /fzrTurnUndispatched\(fzrToken\)/);
});
