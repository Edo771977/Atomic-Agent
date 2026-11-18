// Issue #67 (3): a turn in a folder whose `projects.constraints` entry does
// not allow the picked provider is refused before anything is sent. The
// agent's failure frame carries `code: "ATOMIC_AGENT_PROVIDER_NOT_ALLOWED"`
// (or `ATOMIC_AGENT_EGRESS_NOT_ALLOWED`) and `advice`, the TUI's sentence
// (src/http/failure-reason-frame.ts). Its category is `transport`, so the
// row read "Anthropic is not answering — api.anthropic.com." It now says
// "Turn stopped. <the agent's sentence>", as the TUI does. A refusal before
// the stream (a 400 for the turn's own provider) reads the same way.
// The renderer as text in a vm; the frames are the agent's own (failureReasonFields).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  if (at < 0) return "";
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}

const NAMES = [
  "providerHost", "providerFailure", "providerReplied", "turnWaited", "turnFailure",
  "turnFailureLine", "offlineTurnLine", "constraintTurnLine", "constraintRefusalWords", "constraintFolderWords", "localWrongServerLine", "localContextFullLine",
  "localRequestInvalidLine", "localFailureCode", "localFrameAdvice", "localServerHost", "waitIsLocalServer",
  "selProviders", "selActiveProviderId", "llmBlock", "llmProviders", "llmProvider", "llmLocalModels",
];

const CONFIG = {
  localModels: { mode: "external", url: "http://127.0.0.1:8090" },
  llm: { activeTextProvider: "anthropic", providers: [
    { id: "anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com" },
    { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8090" },
  ] },
};

function window() {
  const c = vm.createContext({
    LIVE_CONFIG: CONFIG, S: { turnStartedAt: Date.now() - 3000 }, SWX: {}, projectTurnModel: () => null, URL,
    esc: (s) => String(s), providerWord: (id) => (id === "anthropic" ? "Anthropic" : String(id)),
    savedKeyInvalid: () => false, billingFailureLine: () => "",
  });
  for (const n of NAMES) { const src = fn(n); if (src) vm.runInContext(src, c); }
  return (ev) => c.turnFailure(ev);
}

// What agent-client.ts makes of the agent's `event: error` frame: the fields lifted, `payload` kept.
function streamEvent(frame) {
  return { kind: "error", error: frame.error, category: frame.category, payload: frame };
}

const FOLDER = "C:\\Users\\me\\Downloads\\riservata";
const PROVIDER_FRAME = {
  error: `folder ${FOLDER} is restricted to: local-llama; provider "anthropic" may not serve the main model, nothing was sent`,
  category: "transport",
  failure: { cause: "unknown" },
  code: "ATOMIC_AGENT_PROVIDER_NOT_ALLOWED",
  advice: "This folder is restricted to: local-llama. The main model can't use anthropic here. — switch to local with ctrl+r or /runmode local",
};
const TAINT_FRAME = {
  error: 'this session read files from /w/secret, which is restricted to: local-llama; provider "anthropic" may not serve the main model, nothing was sent',
  category: "transport",
  code: "ATOMIC_AGENT_PROVIDER_NOT_ALLOWED",
  advice: "This session read files from /w/secret, which is restricted to: local-llama. The main model can't use anthropic here. — switch to local with ctrl+r or /runmode local",
};
const EGRESS_FRAME = {
  error: `folder ${FOLDER} is restricted: web_fetch would send content off this machine; add "web" to projects.constraints[${JSON.stringify(FOLDER)}].allowedEgress to allow it`,
  category: "tool",
  code: "ATOMIC_AGENT_EGRESS_NOT_ALLOWED",
  advice: `This folder (${FOLDER}) is restricted: web_fetch can't send content off this machine here. — add "web" to projects.constraints[${JSON.stringify(FOLDER)}].allowedEgress to allow it`,
};

test("a provider the folder does not allow reads as the turn stopped, in the agent's words, not as Anthropic not answering", () => {
  const r = window()(streamEvent(PROVIDER_FRAME));
  assert.equal(r.text, "Turn stopped. This folder is restricted to: local-llama. The main model can't use anthropic here. — switch to local with /runmode local");
  assert.equal(r.detail, "");
  assert.doesNotMatch(r.text, /not answering|gave up/);
});

test("a read taint and an egress refusal read the same way", () => {
  const row = window();
  assert.equal(row(streamEvent(TAINT_FRAME)).text,
    "Turn stopped. This session read files from /w/secret, which is restricted to: local-llama. The main model can't use anthropic here. — switch to local with /runmode local");
  assert.equal(row(streamEvent(EGRESS_FRAME)).text, "Turn stopped. " + EGRESS_FRAME.advice);
});

test("an agent whose frame has the code but no advice still says it was the folder, from its words", () => {
  const { advice, ...bare } = PROVIDER_FRAME;
  void advice;
  const r = window()(streamEvent(bare));
  assert.equal(r.text, `Turn stopped. The folder ${FOLDER} is restricted to: local-llama, so anthropic can't be used here.`);
});

test("the 400 before the stream (the turn's own provider not allowed) reads as the turn stopped too", () => {
  // agent-client httpErrorDetail: the error's message, then its code/param in brackets.
  const said = `llm provider "anthropic" may not receive this chat's content: folder ${FOLDER} is restricted to: local-llama (provider_id)`;
  const r = window()({ kind: "error", error: said, transport: true, httpStatus: 400 });
  assert.equal(r.text, `Turn stopped. The folder ${FOLDER} is restricted to: local-llama, so anthropic can't be used here.`);
  assert.equal(r.detail, "");
});

test("a provider that really does not answer still reads as not answering", () => {
  const r = window()({ kind: "error", error: "fetch failed", category: "transport", payload: { error: "fetch failed", category: "transport" } });
  assert.match(r.text, /^Anthropic is not answering — api\.anthropic\.com\./);
});
