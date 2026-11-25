import { expect, it } from "vitest";
import { createHttpServer } from "./http-server.js";
import { buildRouteTable } from "./route-table.js";

it("keeps serve elicitation routes absent until questions carry trusted chat ownership", async () => {
  const routes = buildRouteTable();
  expect(routes.filter(route => route.path.startsWith("/api/mcp/elicitation"))).toEqual([]);
  const server = await createHttpServer({ runtime: {} as never, host: "127.0.0.1", port: 0, apiKey: "fixture-owner-key", routes });
  try {
    for (const [method, path] of [["GET", "/api/mcp/elicitation"], ["POST", "/api/mcp/elicitation/answer"]]) {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method, headers: { authorization: "Bearer fixture-owner-key", "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ id: "unknown-or-private", action: "accept", content: { credential: "fixture-secret" } }) } : {}),
      });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("fixture-secret");
    }
  } finally { await server.close(); }
});
