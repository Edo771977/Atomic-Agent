import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpServer } from "./http-server.js";
import { ROUTE_SCOPES } from "./http-scopes.js";
import { hashHttpToken } from "./http-token-store.js";
import { buildRouteTable } from "./route-table.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import { getDefaultArgsJsonSchema } from "../prompt/default-tool-args-schemas.js";

afterEach(() => vi.unstubAllEnvs());

describe("C4a file indexing remains deferred", () => {
  it("exposes no index owner, search tool, schema, descriptor or route", () => {
    for (const path of ["../tools/files/file-index.ts", "../tools/files/files-search-tool.ts", "./route-files.ts", "../runtime/composition/runtime-file-index.ts"]) {
      expect(existsSync(new URL(path, import.meta.url)), path).toBe(false);
    }
    expect(DEFAULT_TOOL_DESCRIPTORS.some(tool => tool.name === "files.search")).toBe(false);
    expect(getDefaultArgsJsonSchema("files.search")).toBeUndefined();
    expect(buildRouteTable().filter(route => route.path.startsWith("/api/files/"))).toEqual([]);
    expect(Object.keys(ROUTE_SCOPES).filter(key => key.includes("/api/files/"))).toEqual([]);
  });

  it.each(["owner", "admin", "operator", "member", "viewer", "anonymous"] as const)(
    "keeps folder mutation and status absent for %s including inherited credentials", async role => {
      vi.stubEnv("ATOMIC_AGENT_TOOL_CHILD", "1");
      const listFolders = vi.fn(() => [{ path: "private-folder-canary" }]);
      const addFolder = vi.fn(); const removeFolder = vi.fn(); const status = vi.fn();
      const server = await createHttpServer({
        runtime: { fileIndex: { listFolders, addFolder, removeFolder, status } } as never,
        host: "127.0.0.1", port: 0, apiKey: "c4-owner", routes: buildRouteTable(),
        namedTokens: () => role === "owner" || role === "anonymous" ? [] : [{ name: "c4", role, sha256: hashHttpToken("c4-named"), createdAt: "" }],
      });
      try {
        for (const offline of ["0", "1"]) {
          vi.stubEnv("ATOMIC_AGENT_OFFLINE", offline);
          for (const [method, path, body] of [
            ["GET", "/api/files/folders", undefined], ["GET", "/api/files/status", undefined],
            ["POST", "/api/files/folders", '{"path":"private-folder-canary"}'],
            ["DELETE", "/api/files/folders", '{"path":"private-folder-canary"}'],
            ["POST", "/api/files/folders", "{broken"],
          ] as const) {
            const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
              method, headers: { "content-type": "application/json", ...(role === "anonymous" ? {} : { authorization: `Bearer ${role === "owner" ? "c4-owner" : "c4-named"}` }) },
              ...(body === undefined ? {} : { body }),
            });
            expect(response.status).toBe(404);
            expect(await response.text()).not.toContain("private-folder-canary");
          }
        }
        for (const operation of [listFolders, addFolder, removeFolder, status]) expect(operation).not.toHaveBeenCalled();
      } finally { await server.close(); }
    },
  );
});
