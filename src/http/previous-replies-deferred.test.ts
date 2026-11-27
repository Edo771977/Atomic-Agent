import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHttpServer } from "./http-server.js";
import { ROUTE_SCOPES } from "./http-scopes.js";
import { hashHttpToken } from "./http-token-store.js";
import { buildRouteTable } from "./route-table.js";

afterEach(() => vi.unstubAllEnvs());

it("keeps both previous-reply routes and their scopes absent", () => {
  const surface = /previous-repl/;
  expect(buildRouteTable().filter(route => surface.test(route.path))).toEqual([]);
  expect(Object.keys(ROUTE_SCOPES).filter(route => surface.test(route))).toEqual([]);
});

it.each(["owner", "admin", "operator", "member", "viewer", "anonymous"] as const)(
  "keeps archived replies unavailable to %s without reading or writing sessions", async role => {
    const dir = mkdtempSync(join(tmpdir(), "c2a-absent-"));
    const file = join(dir, "session-fixture.json");
    const original = '{"turns":[{"kind":"assistant_reply","text":"current answer"}]}\n';
    writeFileSync(file, original);
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", dir);
    const load = vi.fn(() => { throw new Error("deferred route read a session"); });
    const save = vi.fn();
    const server = await createHttpServer({
      runtime: { sessionStore: { load, save } } as never,
      host: "127.0.0.1", port: 0, apiKey: "c2a-owner", routes: buildRouteTable(),
      namedTokens: () => role === "owner" || role === "anonymous" ? [] : [{
        name: "c2a", role, sha256: hashHttpToken("c2a-named"), createdAt: "",
      }],
    });
    try {
      for (const offline of ["0", "1"]) {
        vi.stubEnv("ATOMIC_AGENT_OFFLINE", offline);
        // These labels must never reach the session store: the routes do not exist.
        for (const id of ["ordinary", "incognito", "hidden", "unknown"]) {
          for (const [method, suffix, body] of [
            ["GET", "previous-replies", undefined],
            ["POST", "restore-previous-reply", "{}"],
            ["POST", "restore-previous-reply", '{"index":-1}'],
            ["POST", "restore-previous-reply", "{broken"],
          ] as const) {
            const response = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${id}/${suffix}`, {
              method, headers: {
                "content-type": "application/json",
                ...(role === "anonymous" ? {} : { authorization: `Bearer ${role === "owner" ? "c2a-owner" : "c2a-named"}` }),
              }, ...(body === undefined ? {} : { body }),
            });
            expect(response.status).toBe(404);
            expect(await response.text()).not.toContain("current answer");
          }
        }
      }
      expect(load).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(readFileSync(file, "utf8")).toBe(original);
      expect(readdirSync(dir)).toEqual(["session-fixture.json"]);
    } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
  },
);
