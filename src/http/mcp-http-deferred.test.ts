import { expect, it } from "vitest";

import { createHttpServer } from "./http-server.js";
import { ROUTE_SCOPES } from "./http-scopes.js";
import { hashHttpToken } from "./http-token-store.js";
import { buildRouteTable } from "./route-table.js";

const owner = "b3-fixture-owner-key";
const named = "b3-fixture-named-token";

it.each(["viewer", "member", "operator", "admin", "owner", "anonymous"] as const)(
  "keeps MCP HTTP absent for %s until transport ownership and expiry are enforced",
  async (role) => {
    const routes = buildRouteTable();
    expect(routes.filter(route => route.path === "/mcp")).toEqual([]);
    for (const method of ["GET", "POST", "DELETE"]) expect(ROUTE_SCOPES[`${method} /mcp`]).toBeUndefined();
    const server = await createHttpServer({
      runtime: {} as never, host: "127.0.0.1", port: 0, apiKey: owner, routes,
      namedTokens: () => role === "owner" || role === "anonymous" ? [] : [{ name: "fixture", role, sha256: hashHttpToken(named), createdAt: "" }],
    });
    try {
      for (const method of ["GET", "POST", "DELETE"]) {
        const call = async (sessionId: string) => {
          const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
            method, headers: {
              ...(role === "anonymous" ? {} : { authorization: `Bearer ${role === "owner" ? owner : named}` }),
              "content-type": "application/json", "mcp-session-id": sessionId,
            },
            ...(method === "POST" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) } : {}),
          });
          return { status: response.status, body: await response.text(), length: response.headers.get("content-length") };
        };
        const actual = await call("private-transport");
        expect(actual.status).toBe(404);
        expect(actual).toEqual(await call("unknown-transport"));
      }
    } finally { await server.close(); }
  },
);
