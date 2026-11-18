// Issue #65 (core #60): "Find on my network" and a folder that allows a local
// provider only on this computer. main/folder-provider-hosts.ts decides
// whether a found server's host would be refused for a folder, and adds it to
// that folder's allowedProviderHosts on the person's click only. Its address
// rules are a copy of the agent's (main/ does not import src/), checked here
// against the agent's own functions.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { loadCore } from "./core-ts.mjs";

const stateDir = mkdtempSync(join(tmpdir(), "desktop-folder-hosts-"));
process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
after(() => rmSync(stateDir, { recursive: true, force: true }));
const require = createRequire(import.meta.url);
const cli = require("../out/main/agent-cli.js");
const H = require("../out/main/folder-provider-hosts.js");

const URLS = [
  "http://localhost:8080", "http://LOCALHOST.:8080", "http://127.0.0.1:1234", "http://127.9.9.9", "http://[::1]:8080",
  "http://[::ffff:127.0.0.1]:8080", "http://[::ffff:7f00:1]", "http://[2002:7f00:1::]:80", "http://[64:ff9b::7f00:1]",
  "http://[::127.0.0.1]", "http://foo.localhost:8080", "http://0.0.0.0:8080", "http://[::]:8080",
  "http://192.168.1.20:8080", "http://192.168.1.20.:8080", "http://[::ffff:192.168.1.20]:8080", "http://[::ffff:c0a8:114]",
  "http://10.0.0.5:11434/v1", "http://172.16.0.1", "http://172.32.0.1", "http://169.254.1.1", "http://100.64.0.1", "http://100.127.255.255",
  "http://100.128.0.1", "http://[fe80::1]", "http://[fd12:3456::1]", "http://[fc00::1]", "http://[2001:db8::1]",
  "http://gpu-box.local:1234", "http://GPU-BOX.LAN", "http://nas.home.arpa", "http://box.internal", "http://box.home",
  "http://box.localdomain", "http://box.corp", "http://box.intranet", "http://box.tail1234.ts.net", "http://gpubox:8080",
  "http://192.168.1.5.nip.io", "http://app-10-0-0-7.sslip.io", "http://app-0a000007.nip.io", "http://app.8.8.8.8.nip.io", "http://myapp.nip.io",
  "https://api.openai.com/v1", "https://openrouter.ai/api", "http://8.8.8.8", "http://example.com.local.evil.com",
  "not a url", "", undefined, "http://", "file:///tmp/x",
];

test("the address rules match the agent's (isPrivateNetworkUrl = isLocalServerUrl, constraintHostOf, isLoopbackHost, normalizeProviderHost)", () => {
  const coreLocal = loadCore(new URL("../../src/llm/provider/openai/local-server-url.ts", import.meta.url));
  const coreHost = loadCore(new URL("../../src/llm/provider/url-host.ts", import.meta.url));
  const coreNet = loadCore(new URL("../../src/llm/offline-network.ts", import.meta.url));
  const coreCfg = loadCore(new URL("../../src/config/project-constraints-config.ts", import.meta.url));
  // providerEndpointRefusal (src/llm/provider-policy.ts) for a local endpoint
  // and a policy listing no host: the host it refuses, or null.
  const coreRefused = (url) => {
    const host = coreHost.constraintHostOf(url);
    if (host === null || coreNet.isLoopbackHost(host) || !coreLocal.isLocalServerUrl(url)) return null;
    return host;
  };
  for (const url of URLS) {
    assert.equal(H.isPrivateNetworkUrl(url), coreLocal.isLocalServerUrl(url), `isPrivateNetworkUrl ${url}`);
    assert.equal(H.constraintHostOf(url), coreHost.constraintHostOf(url), `constraintHostOf ${url}`);
    assert.equal(H.networkHostToList(url), coreRefused(url), `networkHostToList ${url}`);
  }
  for (const host of ["localhost", "LOCALHOST.", "127.0.0.1", "[::1]", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "2002:7f00:1::", "192.168.1.20", "foo.localhost", "0.0.0.0", "", "nope"]) {
    assert.equal(H.isLoopbackHost(host), coreNet.isLoopbackHost(host), `isLoopbackHost ${host}`);
  }
  for (const raw of ["192.168.1.20", " GPU-Box.LAN. ", "[::ffff:192.168.1.20]", "::ffff:c0a8:114", "fe80::1", "192.168.1.20:8080", "http://x", "a/b", "*.lan", "", "user@host", "gpu box"]) {
    assert.equal(H.normalizeProviderHost(raw), coreCfg.normalizeProviderHost(raw), `normalizeProviderHost ${JSON.stringify(raw)}`);
  }
});

const cfgWith = (constraints, providers = []) => ({ version: 75, llm: { providers }, projects: { constraints } });

test("a found server on another computer warns for each folder that allows the provider only here", () => {
  const cfg = cfgWith({
    "/work/secret": { allowedProviders: ["local-llama"] },
    "/work/open": { allowedProviders: ["local-llama", "openrouter"], allowedProviderHosts: ["192.168.1.20"] },
    "/work/other": { allowedProviders: ["openrouter"] },
  }, [{ id: "local-llama", kind: "llama-server" }]);
  const w = H.folderHostWarnings(cfg, ["local-llama"], "http://192.168.1.20:8080");
  assert.deepEqual(w, [{
    folder: "/work/secret", providerId: "local-llama", host: "192.168.1.20",
    text: "Folder /work/secret allows local-llama only on this computer; it will refuse 192.168.1.20",
    action: "Allow 192.168.1.20 for /work/secret",
  }]);
  // The host is compared in the agent's one spelling.
  assert.equal(H.folderHostWarnings(cfg, ["local-llama"], "http://[::ffff:192.168.1.20]:8080").length, 1);
  assert.equal(H.folderHostWarnings(cfgWith({ "/a": { allowedProviders: ["local-llama"], allowedProviderHosts: ["gpu-box.lan"] } }), ["local-llama"], "http://GPU-BOX.LAN.:1234").length, 0);
});

test("no warning on this computer, on a public host, for an unlisted or cloud provider, or with no constraints", () => {
  const cfg = cfgWith({ "/w": { allowedProviders: ["local-llama", "custom-gpu", "cloudish"] } }, [
    { id: "local-llama", kind: "llama-server" },
    { id: "cloudish", kind: "openai-compatible", baseUrl: "http://10.0.0.5/v1", modelMode: "cloud" },
    { id: "router", kind: "openrouter" },
  ]);
  for (const url of ["http://127.0.0.1:8080", "http://localhost:1234", "http://[::1]:8080", "https://api.example.com/v1", "not a url"]) {
    assert.deepEqual(H.folderHostWarnings(cfg, ["local-llama"], url), [], url);
  }
  assert.deepEqual(H.folderHostWarnings(cfg, ["someone-else"], "http://10.0.0.5:8080"), []);
  // A provider the agent matches by id alone (marked cloud) is not judged by place.
  assert.deepEqual(H.folderHostWarnings(cfg, ["cloudish"], "http://10.0.0.5:8080"), []);
  // A provider the wizard is about to add (no entry yet) is an openai-compatible one: judged by place.
  assert.equal(H.folderHostWarnings(cfg, ["custom-gpu"], "http://10.0.0.5:8080/v1").length, 1);
  assert.deepEqual(H.folderHostWarnings({ version: 75 }, ["local-llama"], "http://10.0.0.5:8080"), []);
  assert.deepEqual(H.folderHostWarnings(null, ["local-llama"], "http://10.0.0.5:8080"), []);
});

const LLM = { fieldId: "llm-url" };

/** agent-cli's whole-file write, answered in memory (as provider-model-mode.test.mjs does). */
async function withConfig(initial, body) {
  let config = structuredClone(initial);
  const writes = [];
  return cli.withCliStandIn(async (args, input) => {
    if (args[0] === "config" && args[1] === "get") return { ok: true, stdout: JSON.stringify(config), stderr: "" };
    assert.deepEqual(args, ["config", "set", "-"]);
    config = JSON.parse(input);
    writes.push(config);
    return { ok: true, stdout: "", stderr: "" };
  }, () => body(() => config, writes));
}

test("Allow adds the normalised host to that folder only, through the whole-file write; nothing else moves", async () => {
  const initial = cfgWith({
    "/work/secret": { allowedProviders: ["local-llama"], allowedEgress: ["web"] },
    "/work/b": { allowedProviders: ["local-llama"] },
  }, [{ id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" }]);
  initial.mcp = { servers: [{ name: "x", transport: { kind: "stdio", command: "x" } }] };
  await withConfig(initial, async (config, writes) => {
    const r = await H.allowFolderProviderHost("/work/secret", "local-llama", "http://[::ffff:192.168.1.20]:8080/v1", LLM);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.changed, true);
    assert.equal(r.host, "192.168.1.20");
    assert.deepEqual(config().projects.constraints["/work/secret"], { allowedProviders: ["local-llama"], allowedEgress: ["web"], allowedProviderHosts: ["192.168.1.20"] });
    assert.deepEqual(config().projects.constraints["/work/b"], { allowedProviders: ["local-llama"] });
    assert.deepEqual(config().mcp, initial.mcp);
    assert.deepEqual(config().llm, initial.llm);
    // Twice is once.
    const again = await H.allowFolderProviderHost("/work/secret", "local-llama", "http://192.168.1.20:9999", LLM);
    assert.equal(again.ok, true);
    assert.equal(again.changed, false);
    assert.equal(writes.length, 1);
  });
});

test("Allow refuses what no warning offered: an unknown folder, an unlisted provider, this computer, a public host", async () => {
  const initial = cfgWith({ "/w": { allowedProviders: ["local-llama"] } });
  await withConfig(initial, async (config, writes) => {
    for (const [folder, id, url] of [
      ["/nope", "local-llama", "http://192.168.1.20:8080"],
      ["/w", "openrouter", "http://192.168.1.20:8080"],
      ["/w", "local-llama", "http://127.0.0.1:8080"],
      ["/w", "local-llama", "https://api.example.com"],
      ["/w", "local-llama", "not a url"],
      ["__proto__", "local-llama", "http://192.168.1.20:8080"],
    ]) {
      const r = await H.allowFolderProviderHost(folder, id, url, LLM);
      assert.equal(r.ok, false, `${folder} ${id} ${url}`);
      assert.ok(r.error, "says why");
    }
    assert.equal(writes.length, 0);
    assert.deepEqual(config(), initial);
  });
});

test("renderer: the found server's warning and its Allow button, and nothing is added without the click", () => {
  const L = require("../renderer/lan-find.js");
  L.LANF.state = "done";
  L.LANF.servers = [];
  L.LANF.hostWarnings["wiz-url"] = { url: "http://192.168.1.20:8080/v1", list: [{ folder: "/work/secret", providerId: "custom-192-168-1-20-8080-v1", host: "192.168.1.20", text: "Folder /work/secret allows custom-192-168-1-20-8080-v1 only on this computer; it will refuse 192.168.1.20", action: "Allow 192.168.1.20 for /work/secret" }] };
  const html = L.lanfBodyHTML("wiz-url");
  assert.match(html, /Folder \/work\/secret allows custom-192-168-1-20-8080-v1 only on this computer; it will refuse 192\.168\.1\.20/);
  assert.match(html, /data-lanf-allow="0"[^>]*>Allow 192\.168\.1\.20 for \/work\/secret</);
  assert.doesNotMatch(L.lanfBodyHTML("llm-url"), /data-lanf-allow/);
  const src = readFileSync(new URL("../renderer/lan-find.js", import.meta.url), "utf8");
  // The only write is behind the button's click.
  assert.equal(src.split("lanAllowFolderHost(").length - 1, 1);
  assert.match(src, /data-lanf-allow[\s\S]*lanfAllow\(/);
  const preload = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  assert.match(preload, /lanFolderHosts:/);
  assert.match(preload, /lanAllowFolderHost:/);
});

// Review of issue #65: Allow is bound to the field the address is in. The
// provider must be one that field feeds (llm-url: local-llama and URL-less
// llama-server entries; wiz-url: the entry being edited, or the id the
// wizard derives from this very address), so a click cannot list a host for
// a provider the address will never reach.
test("Allow and the warnings only accept a provider the field feeds", async () => {
  const providers = [
    { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
    { id: "spare", kind: "llama-server" },
    { id: "own-url", kind: "llama-server", url: "http://127.0.0.1:9000" },
    { id: "gpu", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1" },
  ];
  const cfg = cfgWith({ "/w": { allowedProviders: ["local-llama", "spare", "own-url", "gpu", "custom-192-168-1-20-8080", "custom-other"] } }, providers);
  assert.deepEqual(H.fieldProviderIds(cfg, { fieldId: "llm-url" }, "http://192.168.1.20:8080"), ["local-llama", "spare"]);
  assert.deepEqual(H.fieldProviderIds(cfg, { fieldId: "wiz-url" }, "http://192.168.1.20:8080/v1"), ["custom-192-168-1-20-8080-v1", "custom-192-168-1-20-8080"]);
  assert.deepEqual(H.fieldProviderIds(cfg, { fieldId: "wiz-url", editingId: "gpu" }, "http://192.168.1.20:8080/v1"), ["gpu"]);
  assert.deepEqual(H.fieldProviderIds(cfg, { fieldId: "wiz-url", editingId: "local-llama" }, "http://192.168.1.20:8080/v1"), ["custom-192-168-1-20-8080-v1", "custom-192-168-1-20-8080"]);
  assert.deepEqual(H.fieldProviderIds(cfg, { fieldId: "nope" }, "http://192.168.1.20:8080"), []);
  const url = "http://192.168.1.20:8080/v1";
  await withConfig(cfg, async (config, writes) => {
    for (const [id, field] of [
      ["custom-other", { fieldId: "wiz-url" }],
      ["gpu", { fieldId: "wiz-url" }],
      ["own-url", { fieldId: "llm-url" }],
      ["custom-192-168-1-20-8080", { fieldId: "llm-url" }],
      ["local-llama", { fieldId: "wiz-url" }],
      ["local-llama", undefined],
    ]) {
      const r = await H.allowFolderProviderHost("/w", id, url, field);
      assert.equal(r.ok, false, `${id} ${JSON.stringify(field)}`);
    }
    assert.equal(writes.length, 0);
    const ok = await H.allowFolderProviderHost("/w", "custom-192-168-1-20-8080", url, { fieldId: "wiz-url" });
    assert.equal(ok.ok, true, ok.error);
    assert.deepEqual(config().projects.constraints["/w"].allowedProviderHosts, ["192.168.1.20"]);
  });
});

test("main's customProviderId is the wizard's (renderer.js)", () => {
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  const m = /\nfunction customProviderId\(url\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(m, "renderer.js customProviderId");
  const renderer = new Function(m[0] + "; return customProviderId;")();
  for (const u of ["http://192.168.1.20:8080", "http://192.168.1.20:8080/v1", "https://GPU-Box.lan:1234/v1/", "", "http://1.2.3.4", "http://" + "a".repeat(60), "http://[fe80::1]:8080"]) {
    assert.equal(H.customProviderId(u), renderer(u), u);
  }
});

// Review item: local-llama is kept for #llm-url even when it has its own url,
// because saving that field rewrites it (setExternalLlamaUrl →
// syncLocalLlamaProviderUrl); dropping it would hide a real refusal. The
// window's list (renderer.js lanfProviderIdsFor) and main's agree.
test("llm-url feeds local-llama even with its own url (the save moves it), and the window agrees with main", async () => {
  const providers = [
    { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
    { id: "spare", kind: "llama-server" },
    { id: "own-url", kind: "llama-server", url: "http://127.0.0.1:9000" },
  ];
  await withConfig({ version: 75, localModels: { mode: "managed" }, llm: { providers } }, async (config) => {
    const w = await cli.setExternalLlamaUrl("http://192.168.1.20:8080");
    assert.equal(w.ok, true, w.error);
    const after = Object.fromEntries(config().llm.providers.map((p) => [p.id, p.url]));
    assert.equal(after["local-llama"], "http://192.168.1.20:8080");
    assert.equal(after["own-url"], "http://127.0.0.1:9000");
  });
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  const fn = /\nfunction lanfProviderIdsFor\(fieldId, url\) \{[\s\S]*?\n\}/.exec(src);
  const cid = /\nfunction customProviderId\(url\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(fn && cid);
  const lanSrc = readFileSync(new URL("../renderer/lan-provider.js", import.meta.url), "utf8");
  const lanFn = /\nfunction lanAddressToBaseUrl\(raw\) \{[\s\S]*?\n\}/.exec(lanSrc);
  const L = { lanAddressToBaseUrl: new Function(lanFn[0] + "; return lanAddressToBaseUrl;")() };
  for (const [WIZ, fieldId, url] of [
    [{}, "llm-url", "http://192.168.1.20:8080"],
    [{ row: { custom: true, lan: true, kind: "openai-compatible" } }, "wiz-url", "http://192.168.1.20:8080/v1"],
    [{ row: { custom: true, kind: "openai-compatible" } }, "wiz-url", "http://10.0.0.5:1234/v1"],
  ]) {
    const ids = new Function("WIZ", "selProviders", "lanAddressToBaseUrl", fn[0] + cid[0] + "; return lanfProviderIdsFor;")(WIZ, () => providers, L.lanAddressToBaseUrl)(fieldId, url);
    const fed = H.fieldProviderIds({ llm: { providers } }, { fieldId }, url);
    assert.ok(ids.length > 0 && ids.every((id) => fed.includes(id)), `${fieldId} ${url}: ${ids} within ${fed}`);
    if (fieldId === "llm-url") assert.deepEqual(ids, ["local-llama", "spare"]);
  }
});

// Review item 7: an address typed (not found or checked) is judged too, when
// the field loses focus.
test("renderer: leaving the address field asks for the folder warnings; an empty or unrelated field does not", async () => {
  const vm = await import("node:vm");
  const src = readFileSync(new URL("../renderer/lan-find.js", import.meta.url), "utf8");
  const listeners = {};
  const calls = [];
  const fields = { "wiz-url": { id: "wiz-url", value: "http://192.168.1.20:8080/v1" }, "llm-url": { id: "llm-url", value: "  " }, "other": { id: "other", value: "http://10.0.0.1" } };
  const ctx = vm.createContext({
    setTimeout: (f) => f(), console,
    document: {
      addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
      getElementById: (id) => fields[id] || null,
      querySelectorAll: () => [],
    },
    window: { atomic: { lanFolderHosts: async (url, ids, field) => { calls.push({ url, ids, field }); return { ok: true, warnings: [] }; } } },
    lanfProviderIdsFor: (fieldId) => (fieldId === "wiz-url" ? ["custom-192-168-1-20-8080"] : ["local-llama"]),
  });
  vm.runInContext(src, ctx);
  assert.ok(listeners.focusout && listeners.focusout.length, "a focusout listener");
  const blur = async (id) => { for (const fn of listeners.focusout) fn({ target: fields[id] }); await new Promise((r) => setImmediate(r)); };
  await blur("wiz-url");
  await blur("llm-url");
  await blur("other");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://192.168.1.20:8080/v1");
  assert.equal(calls[0].field.fieldId, "wiz-url");
});

// Issue #74: the blur's ask and Check's ask for the same field could answer
// out of order, and the older address's warnings overwrote the newer's.
test("renderer: an older folder-hosts answer for a field does not overwrite a newer one", async () => {
  const vm = await import("node:vm");
  const src = readFileSync(new URL("../renderer/lan-find.js", import.meta.url), "utf8");
  const slow = [];
  const warn = (host) => ({ ok: true, warnings: [{ folder: "/work/secret", providerId: "custom", host }] });
  const ctx = vm.createContext({
    setTimeout: (f) => f(), console,
    document: { addEventListener: () => {}, getElementById: () => null, querySelectorAll: () => [] },
    window: { atomic: { lanFolderHosts: (url) => url.includes("10.0.0.1")
      ? new Promise((r) => slow.push(() => r(warn("10.0.0.1")))) : Promise.resolve(warn("192.168.1.20")) } },
    lanfProviderIdsFor: () => ["custom"],
  });
  vm.runInContext(src, ctx);
  const first = ctx.lanfFolderHosts("wiz-url", "http://10.0.0.1:8080/v1");      // the blur, for the address typed before
  await ctx.lanfFolderHosts("wiz-url", "http://192.168.1.20:8080/v1");          // Check, for the address now in the field
  slow.forEach((f) => f());
  await first;
  assert.equal(vm.runInContext("LANF.hostWarnings['wiz-url'].url", ctx), "http://192.168.1.20:8080/v1", "the older answer won");
  assert.equal(vm.runInContext("LANF.hostWarnings['wiz-url'].list[0].host", ctx), "192.168.1.20");
});
