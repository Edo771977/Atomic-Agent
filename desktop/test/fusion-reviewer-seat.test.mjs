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
  workers: [member("local-llama:default")],
  reviewers: [member("codex-cli:default"), member("openrouter:model-o", { usable: false, reason: "folder", why: "this folder (/w) does not allow openrouter" })],
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
    [["codex-cli:default", true, null], ["openrouter:model-o", false, "this folder (/w) does not allow openrouter"]]);
  assert.deepEqual(read.chat, { director: "anthropic:model-a", worker: null, reviewer: null });
  for (const answer of [null, { status: 404, body: null }, { status: 200, body: { configured: "yes" } }]) {
    assert.equal(M.readFusionTeam(answer).known, false, JSON.stringify(answer));
  }
});

test("Add a reviewer creates the team from the two seats when there is none, and changes nothing else", () => {
  const cfg = config();
  const before = JSON.parse(JSON.stringify(cfg));
  const plan = M.planAddReviewer(cfg, "codex-cli:default");
  assert.equal(plan.write, true);
  assert.deepEqual(plan.team, { directors: ["anthropic:model-a"], workers: ["local-llama:default"], reviewers: ["codex-cli:default"] });
  assert.deepEqual(cfg.llm.runMode.fusion.team, plan.team);
  delete cfg.llm.runMode.fusion.team;
  assert.deepEqual(cfg, before);
});

test("Add a reviewer appends to an existing team, once, and refuses a provider that is not configured", () => {
  const cfg = config({ directors: ["anthropic:model-a"], reviewers: ["openrouter:model-o"], review: "off" });
  const plan = M.planAddReviewer(cfg, "codex-cli:default");
  assert.deepEqual(plan.team, { directors: ["anthropic:model-a"], reviewers: ["openrouter:model-o", "codex-cli:default"], review: "off" });
  assert.equal(M.planAddReviewer(cfg, "codex-cli:default").write, false);
  assert.match(M.planAddReviewer(config(), "nobody:model").error, /not a configured provider/);
  assert.match(M.planAddReviewer(config(), "no-model").error, /<providerId>:<model>/);
});

test("a seat moved to a model the team does not list is added to its directors or workers", () => {
  const cfg = config({ directors: ["anthropic:model-a"], workers: ["local-llama:default"], reviewers: ["codex-cli:default"] });
  assert.equal(M.planFollowLegs(cfg).write, false);
  cfg.llm.runMode.fusion.orchestratorProvider = "openrouter";
  const plan = M.planFollowLegs(cfg);
  assert.equal(plan.write, true);
  assert.deepEqual(plan.team.directors, ["openrouter:model-o", "anthropic:model-a"]);
  assert.deepEqual(plan.team.reviewers, ["codex-cli:default"]);
  assert.equal(M.planFollowLegs(config()).write, false);
});

test("a turn names the seats' members the chat can use, and the chat's reviewer", () => {
  const cfg = config({ directors: ["anthropic:model-a"], workers: ["local-llama:default"], reviewers: ["codex-cli:default"] });
  const roster = M.readFusionTeam({ status: 200, body: ROSTER_BODY });
  assert.deepEqual(M.turnTeamFields(cfg, roster, "codex-cli:default"),
    { director: "anthropic:model-a", worker: "local-llama:default", reviewer: "codex-cli:default" });
  assert.deepEqual(M.turnTeamFields(cfg, roster, "none"), { director: "anthropic:model-a", worker: "local-llama:default", reviewer: "none" });
  // A seat the folder refuses is not named: the agent then runs Fusion as the folder allows.
  const refused = M.readFusionTeam({ status: 200, body: { ...ROSTER_BODY, directors: [member("anthropic:model-a", { usable: false, reason: "folder", why: "x" })] } });
  assert.deepEqual(M.turnTeamFields(cfg, refused, undefined), { worker: "local-llama:default" });
  // No team, or another route: nothing, so a setup without a team works as before.
  assert.deepEqual(M.turnTeamFields(config(), roster, "codex-cli:default"), {});
  const cloud = config({ directors: ["anthropic:model-a"] });
  cloud.llm.runMode.mode = "cloud";
  assert.deepEqual(M.turnTeamFields(cloud, roster, "none"), {});
  assert.deepEqual(M.teamChoiceFromWindow({ reviewer: "codex-cli:default" }), { reviewer: "codex-cli:default" });
  assert.deepEqual(M.teamChoiceFromWindow({ reviewer: "none" }), { reviewer: "none" });
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
    assert.equal(M.readFusionTeam(answer).reviewers.length, 2);
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
    ["none", null, false, false],
    ["add", null, false, false],
  ]);
  assert.equal(rows[2].detail, "this folder (/w) does not allow openrouter");
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

test("window: a pick rides on the chat's next turn once; Add a reviewer writes the team and becomes the choice", async () => {
  const writes = [];
  const c = seatContext(M.readFusionTeam({ status: 200, body: ROSTER_BODY }), writes);
  await c.fzrRefresh("s1");
  assert.match(c.fzrSeatHTML(), /Team picks/);
  await c.fzrAct("pick:none");
  assert.match(c.fzrSeatHTML(), /No review/);
  assert.deepEqual({ ...c.fzrTurnTeam("s1") }, { reviewer: "none" });
  c.fzrTurnSent("s1");
  assert.equal(c.fzrTurnTeam("s1"), null);
  await c.fzrAct("add:anthropic:model-a");
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [{ op: "addReviewer", ref: "anthropic:model-a" }]);
  assert.deepEqual({ ...c.fzrTurnTeam("s1") }, { reviewer: "anthropic:model-a" });
  // A leg moved with a team in the config: the team follows it.
  c.LIVE_CONFIG.llm.runMode.fusion.team = { directors: ["anthropic:model-a"] };
  await c.fzrLegsMoved();
  assert.deepEqual({ ...writes.at(-1) }, { op: "followLegs" });
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
