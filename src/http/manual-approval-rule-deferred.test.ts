import { expect, it } from "vitest";
import { createHttpServer } from "./http-server.js";
import { buildRouteTable } from "./route-table.js";

it("keeps handwritten persistent approval rules unavailable until tool-child callers can be excluded", async () => {
  const routes = buildRouteTable();
  expect(routes.some(route => route.method === "POST" && route.path === "/api/approval-rules")).toBe(false);
  const server = await createHttpServer({ runtime: {} as never, host: "127.0.0.1", port: 0, apiKey: "fixture-owner-key", routes });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/approval-rules`, {
      method: "POST", headers: { authorization: "Bearer fixture-owner-key", "content-type": "application/json" },
      body: JSON.stringify({ decision: "allow", commandPrefix: ["git", "status"], project: process.cwd() }),
    });
    expect(response.status).toBe(404);
  } finally { await server.close(); }
});
