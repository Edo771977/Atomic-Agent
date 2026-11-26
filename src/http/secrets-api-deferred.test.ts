import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { handleSecrets } from "../cli/config-secrets-command.js";
import { createHttpServer } from "./http-server.js";
import { ROUTE_SCOPES } from "./http-scopes.js";
import { hashHttpToken } from "./http-token-store.js";
import { buildRouteTable } from "./route-table.js";

const sentinel = "b4a_absence_private_sentinel_4c2e97";
const owner = "b4a-fixture-owner-key";
const named = "b4a-fixture-named-token";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each(["viewer", "member", "operator", "admin", "owner", "anonymous"] as const)(
  "keeps secret read and mutation routes absent for %s, including a child with an inherited owner key",
  async role => {
    vi.stubEnv("ATOMIC_AGENT_TOOL_CHILD", "1");
    const routes = buildRouteTable();
    expect(routes.filter(route => route.path.startsWith("/api/secrets"))).toEqual([]);
    expect(Object.keys(ROUTE_SCOPES).filter(key => key.includes("/api/secrets"))).toEqual([]);
    const server = await createHttpServer({
      runtime: {} as never, host: "127.0.0.1", port: 0, apiKey: owner, routes,
      namedTokens: () => role === "owner" || role === "anonymous" ? [] : [{ name: "fixture", role, sha256: hashHttpToken(named), createdAt: "" }],
    });
    try {
      for (const [method, path, body] of [
        ["GET", "/api/secrets", undefined],
        ["GET", "/api/secrets/FIXTURE_API_KEY", undefined],
        ["PUT", "/api/secrets/FIXTURE_API_KEY", JSON.stringify({ value: sentinel })],
        ["PUT", "/api/secrets/FIXTURE_API_KEY", `{"value":"${sentinel}" BROKEN`],
        ["PUT", "/api/secrets/FIXTURE_API_KEY", JSON.stringify({ value: null })],
      ] as const) {
        const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
          method, headers: { "content-type": "application/json", ...(role === "anonymous" ? {} : { authorization: `Bearer ${role === "owner" ? owner : named}` }) },
          ...(body === undefined ? {} : { body }),
        });
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain(sentinel);
      }
    } finally { await server.close(); }
  },
);

it.each([false, true])("keeps CLI get/set/unset unavailable with offline=%s, without new durable state or output secrets", async offline => {
  const dir = mkdtempSync(join(tmpdir(), "b4a-absent-"));
  const envText = `FIXTURE_API_KEY=${sentinel}\n`;
  writeFileSync(join(dir, ".env"), envText);
  vi.stubEnv("ATOMIC_AGENT_TOOL_CHILD", "1");
  vi.stubEnv("ATOMIC_AGENT_OFFLINE", offline ? "1" : "0");
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation(chunk => { output.push(String(chunk)); return true; });
  try {
    for (const verb of ["get", "set", "unset"]) expect(await handleSecrets([verb, "FIXTURE_API_KEY"], dir)).toBe(1);
    expect(await handleSecrets(["status"], dir)).toBe(0);
    expect(output.join("")).not.toContain(sentinel);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(envText);
    expect(readdirSync(dir)).toEqual([".env"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
