import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROUTE_SCOPES, routeKey } from "./http-scopes.js";
import { buildRouteTable } from "./route-table.js";

describe("C3b facts jobs remain deferred", () => {
  const routes = buildRouteTable();
  it.each([
    ["POST", "/api/import/facts/start"],
    ["GET", "/api/import/facts/jobs/{id}"],
    ["POST", "/api/import/facts/jobs/{id}/stop"],
    ["POST", "/api/import/facts/jobs/{id}/save"],
    ["DELETE", "/api/import/facts/jobs/{id}"],
    ["GET", "/api/import/facts/receipts"],
    ["POST", "/api/import/facts/receipts/{id}/undo"],
  ])("does not register %s %s or grant a scope", (method, path) => {
    expect(routes.some(r => r.method === method && r.path === path)).toBe(false);
    expect(ROUTE_SCOPES[routeKey(method, path)]).toBeUndefined();
  });
  it("exposes no reader, job service or receipt persistence behind another caller", () => {
    for (const owner of ["read-chat-export", "import-facts-jobs", "import-facts-service", "import-facts-receipts", "import-facts-model"]) {
      expect(existsSync(fileURLToPath(new URL(`../import/user-facts/${owner}.ts`, import.meta.url)))).toBe(false);
    }
  });
});
