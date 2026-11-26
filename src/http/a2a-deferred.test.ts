import { expect, it } from "vitest";

import { parseArgs } from "../cli/serve-args.js";
import { createHttpServer } from "./http-server.js";
import { ROUTE_SCOPES } from "./http-scopes.js";
import { hashHttpToken } from "./http-token-store.js";
import { buildRouteTable } from "./route-table.js";

const owner = "b3-fixture-owner-key";
const named = "b3-fixture-named-token";

it("does not accept --a2a before the protocol satisfies the fork's ingress contract", () => {
  expect(parseArgs(["--a2a"])).toEqual({ error: "unknown flag: --a2a" });
});

it.each(["viewer", "member", "operator", "admin", "owner", "anonymous"] as const)(
  "keeps A2A discovery, task history and task controls absent for %s",
  async (role) => {
    const routes = buildRouteTable();
    expect(routes.filter(route => route.path === "/api/a2a" || route.path === "/.well-known/agent-card.json")).toEqual([]);
    expect(ROUTE_SCOPES["POST /api/a2a"]).toBeUndefined();
    expect(ROUTE_SCOPES["GET /.well-known/agent-card.json"]).toBeUndefined();
    const server = await createHttpServer({
      runtime: {} as never, host: "127.0.0.1", port: 0, apiKey: owner, routes,
      namedTokens: () => role === "owner" || role === "anonymous" ? [] : [{ name: "fixture", role, sha256: hashHttpToken(named), createdAt: "" }],
    });
    try {
      for (const operation of ["card", "tasks/get", "tasks/cancel", "message/send"]) {
        const call = async (unknownRoute: boolean, id: string) => {
          const response = await fetch(`http://127.0.0.1:${server.port}${unknownRoute ? "/b3-unknown-route" : operation === "card" ? "/.well-known/agent-card.json" : "/api/a2a"}`, {
            method: operation === "card" ? "GET" : "POST",
            headers: { "content-type": "application/json", ...(role === "anonymous" ? {} : { authorization: `Bearer ${role === "owner" ? owner : named}` }) },
            ...(operation === "card" ? {} : { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: operation, params: { id, message: { role: "user", messageId: "fixture", contextId: id, parts: [{ kind: "text", text: "fixture" }] } } }) }),
          });
          return { status: response.status, body: await response.text(), length: response.headers.get("content-length") };
        };
        const actual = await call(false, "private-chat-or-task");
        expect(actual.status).toBe(404);
        expect(actual).toEqual(await call(false, "unknown-chat-or-task"));
        expect((await call(true, "unknown-chat-or-task")).status).toBe(404);
      }
    } finally { await server.close(); }
  },
);
