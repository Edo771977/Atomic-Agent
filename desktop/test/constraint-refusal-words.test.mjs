// Review of issue #67, item 7: the failure row reads an older agent's
// constraint refusal from its words (no `code`/`advice` in the frame). A
// shell command refused for running a network client
// (ShellNetworkNotAllowedError, src/tools/tool-egress.ts) did not match and
// read "… is not answering"; and a chat restricted by two folders (a read
// taint: key "A + B", openai-chat-completions.ts turnModelPolicyRefusal)
// read "The folder A + B is restricted". Now the shell refusal has its own
// sentence and several folders read "The folders A and B are restricted".
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
const c = vm.createContext({});
for (const n of ["constraintTurnLine", "constraintRefusalWords", "constraintFolderWords"]) { const s = fn(n); if (s) vm.runInContext(s, c); }
const line = (error, category = "transport") => c.constraintTurnLine({ kind: "error", error, category, payload: { error, category } });

test("a shell command refused for a network client reads as the turn stopped", () => {
  const said = 'folder /work/client is restricted: os.shell.run runs curl, a network client that could send content off this machine; '
    + 'add "http" to projects.constraints["/work/client"].allowedEgress to allow it. This is a best-effort check of the command line; the shell is not a sandbox';
  assert.equal(line(said, "tool"), "Turn stopped. The folder /work/client is restricted: os.shell.run runs curl, which could send content off this machine.");
});

test("a policy of two folders reads as the folders, not as one folder named 'A + B'", () => {
  const said = 'llm provider "anthropic" may not receive this chat\'s content: folder /work/a + /work/b is restricted to: local-llama (provider_id)';
  assert.equal(line(said), "Turn stopped. The folders /work/a and /work/b are restricted to: local-llama, so anthropic can't be used here.");
  const three = "folder /a + /b + /c is restricted: web_fetch would send content off this machine; add \"web\" to …";
  assert.equal(line(three, "tool"), "Turn stopped. The folders /a, /b and /c are restricted: web_fetch can't send content off this machine here.");
  // One folder reads as before.
  assert.equal(line('folder /work/a is restricted to: local-llama; provider "anthropic" may not serve the main model, nothing was sent'),
    "Turn stopped. The folder /work/a is restricted to: local-llama, so anthropic can't be used here.");
});

// Issue #74: the core's remote-endpoint refusal (provider-policy.ts
// remoteEndpointSentence) read as the folder refusing the provider ("so this
// provider can't be used here"), when the provider is allowed and its
// endpoint is the problem: it names the host and allowedProviderHosts now.
test("a provider allowed but on another machine names its endpoint and allowedProviderHosts", () => {
  const said = 'folder /work/client is restricted to: lan-llama; provider "lan-llama" is allowed, but its endpoint 192.168.1.20 is another machine; '
    + 'nothing was sent. To allow it, add "192.168.1.20" to projects.constraints["/work/client"].allowedProviderHosts';
  assert.equal(line(said),
    'Turn stopped. The folder /work/client is restricted to: lan-llama; lan-llama is allowed, but its endpoint 192.168.1.20 is another machine. '
    + 'To allow it, add "192.168.1.20" to projects.constraints["/work/client"].allowedProviderHosts.');
  const taint = 'this session read files from /work/a, which is restricted to: lan-llama; provider "lan-llama" is allowed, but its endpoint box.lan is another machine; '
    + 'nothing was sent. To allow it, add "box.lan" to projects.constraints["/work/a"].allowedProviderHosts';
  assert.equal(line(taint),
    'Turn stopped. This session read files from /work/a, which is restricted to: lan-llama; lan-llama is allowed, but its endpoint box.lan is another machine. '
    + 'To allow it, add "box.lan" to projects.constraints["/work/a"].allowedProviderHosts.');
  const unread = 'folder /work/client is restricted to: lan-llama; provider "lan-llama" is allowed, but its endpoint cannot be read, so it may be another machine; '
    + "nothing was sent. Fix the provider's URL";
  assert.equal(line(unread),
    "Turn stopped. The folder /work/client is restricted to: lan-llama; lan-llama is allowed, but its endpoint cannot be read, so it may be another machine. Fix the provider's URL.");
});
