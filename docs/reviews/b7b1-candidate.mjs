import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
const root = resolve(process.argv[2] ?? process.env.B7B1_CANDIDATE_ROOT ?? "");
if (!process.argv[2] && !process.env.B7B1_CANDIDATE_ROOT) throw Error("Supply a disposable candidate checkout path");
const state = mkdtempSync(join(tmpdir(), "b7b1-review-"));
process.env.ATOMIC_AGENT_STATE_DIR = state;
const load = path => import(pathToFileURL(join(root, "src", path)).href);
const { buildOsWebCrawlTool } = await load("tools/os/web/web-crawl.ts");
const { setOfflineNetwork } = await load("llm/offline-network.ts");
const { after } = await import("node:test");
after(() => rmSync(state, { recursive: true, force: true }));
afterEach(() => setOfflineNetwork(false));
for (const offline of [false, true]) test(`automatic JS rendering remains absent (offline=${offline})`, async () => {
  setOfflineNetwork(offline);
  let renders = 0, requests = 0;
  const tool = buildOsWebCrawlTool({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }], sleep: async () => {},
    renderPage: async ({ url }) => { renders++; return { finalUrl: url, title: "Rendered", html: "<html><main>Rendered body</main></html>" }; },
    runCommand: async (_cmd, args) => {
      requests++;
      const robots = args.at(-1).endsWith("/robots.txt");
      const body = robots ? "User-agent: *\nAllow: /" : '<html><head><script src="/app.js"></script></head><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript></body></html>';
      return { command: "curl", args, exitCode: 0, signal: null, stdout: `${body}\n__ATOMIC_WEBFETCH_META__200|${robots ? "text/plain" : "text/html"}||0|{}`, stderr: "", durationMs: 0, timedOut: false, truncated: false };
    },
  });
  await tool.run({ url: "https://docs.example.test/", maxDepth: 0, useSitemap: false }, { workingDir: state, sessionId: "review", stepIndex: 0, signal: new AbortController().signal });
  assert.equal(renders, 0, "No renderer may run until all subrequests and resource budgets have a guard");
  if (offline) assert.equal(requests, 0);
});
