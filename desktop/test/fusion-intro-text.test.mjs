// The Fusion intro a chat prints when it switches to Fusion: main/run-mode.ts
// describeFusionIntro and renderer.js fzIntroParagraphs are the same text, and
// it names the fork's three seats (the Reviewer is the strip's last chip, with
// the words that chip and its popover use), the project gates and restricted
// folders. Run: npm run build first (main is read from out/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { describeFusionIntro } = require("../out/main/run-mode.js");
const renderer = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
const at = renderer.indexOf("\nfunction fzIntroParagraphs(");
const c = vm.createContext({ fzProviderWord: (id) => (id ? ({ "local-llama": "Local models", openrouter: "OpenRouter" })[id] || id : null) });
vm.runInContext(renderer.slice(at + 1, renderer.indexOf("\n}\n", at) + 3), c);
const R = require("../renderer/fusion-reviewer.js");

const seats = [
  { orchestratorModel: "claude-sonnet", workerModel: "gemma", orchestratorProviderId: "openrouter", workerProviderId: "local-llama" },
  { orchestratorModel: null, workerModel: null, orchestratorProviderId: "openrouter", workerProviderId: "local-llama" },
  { orchestratorModel: null, workerModel: null, orchestratorProviderId: null, workerProviderId: null },
];
const word = (id) => ({ "local-llama": "Local models", openrouter: "OpenRouter" })[id] || id;

test("the window's Fusion intro is main's, word for word", () => {
  for (const rm of seats) assert.deepEqual([...c.fzIntroParagraphs(rm)], describeFusionIntro(rm, word), JSON.stringify(rm));
});

test("the Fusion intro names the team, the Reviewer seat with its chip's words, the project gates and restricted folders", () => {
  const text = describeFusionIntro(seats[0], word);
  assert.equal(text[0], "Fusion splits the work in a small team: one model decides, others do, and a reviewer can check.");
  assert.match(text[1], /^Right now, claude-sonnet plans\./);
  assert.equal(text[2], "A third seat, the reviewer, checks each worker's result before the orchestrator takes it. Pick it per chat with the last chip in the strip: “Team picks” lets the team choose, “No review” turns review off, and “Add a reviewer…” adds one. A Claude Code or Codex (ChatGPT) subscription can review, read-only, on your plan.");
  assert.equal(text[3], "Ask for something bigger and it becomes a project that stops for you three times: the brief, the plan (each task's worker, reviewer and estimated cost), and each finished milestone with its checks.");
  assert.equal(text[4], "In a folder restricted to local models, Fusion runs on the local worker alone and cloud reviewers are not offered.");
  assert.ok(!text.some((p) => /between two models/.test(p)));
  // The words are the seat's own (fusion-reviewer.js).
  const roster = { configured: true, reviewers: [{ ref: "codex-cli:default", usable: true }], chat: null };
  const labels = R.fzrRows(roster, null, (id) => id).map((r) => r.label);
  for (const w of ["Team picks", "No review", "Add a reviewer…"]) {
    assert.ok(labels.includes(w), w + " is a row of the seat");
    assert.ok(text[2].includes("“" + w + "”"), w + " is in the intro");
  }
  assert.equal(R.fzrSeatWord(roster, null, (id) => id), "Team picks");
});
