import { afterEach, beforeEach, expect, it } from "vitest";
import { createHttpServer, type HttpServerHandle } from "./http-server.js";
import { buildRouteTable } from "./route-table.js";
import { ROUTE_SCOPES } from "./http-scopes.js";
import { egressSnapshot, setOfflineNetwork } from "../llm/offline-network.js";

const ASSETS = [
  ["/panel/manifest.webmanifest", "application/manifest+json"],
  ["/panel/icon.svg", "image/svg+xml"],
  ["/panel/icon-180.png", "image/png"],
] as const;
const KEY = "panel-secret-not-in-static-assets";
let handle: HttpServerHandle;
let base: string;
beforeEach(async () => {
  handle = await createHttpServer({ runtime: {} as never, host: "127.0.0.1", port: 0, apiKey: KEY, routes: buildRouteTable() });
  base = `http://127.0.0.1:${handle.port}`;
});
afterEach(async () => { await handle.close(); setOfflineNetwork(false); });

it.each(ASSETS)("serves only fixed public bytes at %s, with restrictive headers", async (path, contentType) => {
  const response = await fetch(base + path + "?key=" + KEY + "&session=PRIVATE-CHAT&path=../../config.json", { headers: { host: "private-host.example:9876" } });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain(contentType);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes.equals(Buffer.from(await (await fetch(base + path)).arrayBuffer()))).toBe(true);
  for (const secret of [KEY, "PRIVATE-CHAT", "private-host.example", "9876"]) expect(bytes.toString()).not.toContain(secret);
  expect(ROUTE_SCOPES[`GET ${path}`]).toBe("public-read");
});

it("keeps manifest navigation and icons fixed, without credentials or external resources", async () => {
  const manifest = await (await fetch(base + ASSETS[0][0])).json();
  expect(manifest).toEqual({
    name: "Atomic Agent", short_name: "Atomic Agent", description: "Your agent's chats and approvals, from your phone.",
    id: "/panel", start_url: "/panel", scope: "/panel", display: "standalone", background_color: "#ffffff", theme_color: "#006aff",
    icons: [{ src: "/panel/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }, { src: "/panel/icon-180.png", sizes: "180x180", type: "image/png" }],
  });
  const html = await (await fetch(base + "/panel")).text();
  expect(html).toContain('rel="manifest" href="/panel/manifest.webmanifest"');
  expect(html).not.toMatch(/(?:src|href)=["']https?:/);
});

it("has no service worker or response cache, and works with the runtime offline switch", async () => {
  setOfflineNetwork(true);
  for (const [path] of ASSETS) expect((await fetch(base + path)).status).toBe(200);
  const js = await (await fetch(base + "/panel/app.js")).text();
  expect(js).not.toMatch(/serviceWorker|caches\.|CacheStorage/);
  for (const path of ["/panel/sw.js", "/panel/service-worker.js"]) expect((await fetch(base + path)).status).toBe(404);
  expect(egressSnapshot()).toMatchObject({ bytesOut: 0, requestsOut: 0 });
});

it("keeps an exact public allowlist and never exposes API data through panel paths", async () => {
  const open = buildRouteTable().filter(route => route.requiresAuth === false).map(route => `${route.method} ${route.path}`);
  expect(open).toEqual(["GET /health", "GET /panel", "GET /panel/app.js", ...ASSETS.map(([path]) => `GET ${path}`)]);
  for (const path of ["/api/sessions", "/v1/models", "/panel/../api/sessions", "/panel/manifest.json/../..", "/panel/%2e%2e/api/sessions", "/panel/manifest.webmanifest/../../api/sessions"]) {
    expect([401, 404]).toContain((await fetch(base + path)).status);
  }
});
