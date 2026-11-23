export type HttpScope = "read" | "chat" | "decide" | "admin" | "owner";

export const HTTP_SCOPES: readonly HttpScope[] = ["read", "chat", "decide", "admin"];

export type HttpRole = "admin" | "operator" | "member" | "viewer";

export const HTTP_ROLES: readonly HttpRole[] = ["admin", "operator", "member", "viewer"];

export const ROLE_SCOPES: Readonly<Record<HttpRole, readonly HttpScope[]>> = {
  admin: ["read", "chat", "decide", "admin"],
  operator: ["read", "chat", "decide"],
  member: ["read", "chat"],
  viewer: ["read"],
};

export function isHttpRole(value: unknown): value is HttpRole {
  return typeof value === "string" && (HTTP_ROLES as readonly string[]).includes(value);
}

export function roleHasScope(role: HttpRole, scope: HttpScope): boolean {
  return ROLE_SCOPES[role].includes(scope);
}

/** `"POST /api/config"`: how a route is named in the scope table and in errors. */
export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * The scope each authenticated route of `buildRouteTable` needs. Pinned by
 * `http-scopes.test.ts`: a new authenticated route without an entry here,
 * or an entry for a route that is gone, fails that test. A route that is
 * missing at runtime anyway (a test server's own routes) needs the owner key.
 */
export const ROUTE_SCOPES: Readonly<Record<string, HttpScope>> = {
  "GET /v1/models": "read",
  "GET /metrics": "admin",
  "POST /v1/chat/completions": "chat",
  "POST /v1/chat/completions/{completion_id}/cancel": "chat",
  "POST /v1/messages": "chat",
  "POST /v1/messages/count_tokens": "chat",
  "POST /v1/responses": "chat",
  "POST /api/ag-ui": "chat",
  "GET /api/capabilities": "read",
  "GET /api/model-tiers": "read",
  "POST /api/sessions/{id}/compact": "chat",
  "GET /api/sessions/{id}/compaction": "read",
  "GET /api/config": "admin",
  "PATCH /api/config": "admin",
  "PUT /api/config": "admin",
  "GET /api/skills": "read",
  "GET /api/skills/{name}": "read",
  "POST /api/skills/install": "admin",
  "POST /api/skills/uninstall": "admin",
  "GET /api/project-trust": "read",
  "POST /api/project-trust": "decide",
  "POST /api/mcp/servers/{name}/restart": "admin",
  "POST /api/mcp/servers/{name}/enable": "admin",
  "POST /api/mcp/servers/{name}/disable": "admin",
  "POST /api/mcp/servers/{name}/auth/start": "admin",
  "GET /api/mcp/servers/{name}/auth": "read",
  "POST /api/mcp/servers/{name}/auth/signout": "admin",
  "GET /api/sessions": "read",
  "GET /api/sessions/search": "read",
  "GET /api/sessions/{id}": "read",
  "DELETE /api/sessions/{id}": "admin",
  "PATCH /api/sessions/{id}": "chat",
  "GET /api/sessions/{id}/provider-restriction": "read",
  "GET /api/sessions/{id}/export": "read",
  "POST /api/sessions/{id}/working-dir": "chat",
  "GET /api/sessions/{id}/goal": "read",
  "POST /api/sessions/{id}/goal": "chat",
  "GET /api/sessions/{id}/next-step": "read",
  "POST /api/sessions/{id}/archived": "chat",
  "POST /api/sessions/{id}/rollback-last-turn": "admin",
  "GET /api/sessions/{id}/rewind-points": "read",
  "POST /api/sessions/{id}/rewind/preview": "chat",
  "POST /api/sessions/{id}/rewind": "admin",
  "POST /api/sessions/{id}/fork": "chat",
  "POST /api/sessions/{id}/fs/restore": "admin",
  "POST /api/sessions/{id}/resume": "chat",
  "POST /api/sessions/{id}/steer": "chat",
  "GET /api/sessions/{id}/steer": "read",
  "DELETE /api/sessions/{id}/steer": "chat",
  "GET /api/sessions/{id}/fusion/workers": "read",
  "POST /api/sessions/{id}/fusion/workers/{taskId}/stop": "chat",
  "POST /api/sessions/{id}/fusion/workers/{taskId}/steer": "chat",
  "POST /api/sessions/{id}/fusion/workers/{taskId}/escalate": "chat",
  "POST /api/approval/resolve": "decide",
  "GET /api/events": "read",
  "POST /api/question/answer": "decide",
  "GET /api/project": "read",
  "POST /api/project/decision": "decide",
  "GET /api/project/lessons": "read",
  "POST /api/project/lessons": "decide",
  "POST /api/project/backlog": "decide",
  "GET /api/projects": "read",
  "POST /api/projects/forget": "admin",
  "POST /api/projects/resume": "chat",
  "GET /api/fusion/team": "read",
  "GET /api/approval-rules": "admin",
  "DELETE /api/approval-rules/{id}": "admin",
  "GET /api/coding-mode": "read",
  "POST /api/coding-mode": "admin",
  "GET /api/offline-mode": "read",
  "POST /api/offline-mode": "admin",
  "POST /api/context-preview": "chat",
  "POST /api/complete": "chat",
  "POST /api/local-model/recheck": "admin",
  "POST /api/llm/active": "admin",
  "GET /api/local-models/list": "read",
  "GET /api/local-models/status": "read",
  "GET /api/local-models/list-embeddings": "read",
  "POST /api/memory/embeddings/reconnect": "admin",
  "GET /api/memory/notes": "read",
  "PATCH /api/memory/notes/{id}": "admin",
  "DELETE /api/memory/notes/{id}": "admin",
  "GET /api/memory/profile": "read",
  "GET /api/memory/profile/{key}/history": "read",
  "PATCH /api/memory/profile/{key}": "admin",
  "DELETE /api/memory/profile/{key}": "admin",
  "GET /api/memory/changes": "read",
  "POST /api/memory/changes/{id}/restore": "admin",
  "POST /api/memory/profile/{key}/restore": "admin",
  "POST /api/telegram/pairing": "admin",
  "GET /api/telegram/pairing": "admin",
  "DELETE /api/telegram/pairing": "admin",
  "GET /api/telegram/channel": "read",
  "POST /api/tasks": "admin",
  "GET /api/tasks": "read",
  "GET /api/tasks/{id}": "read",
  "DELETE /api/tasks/{id}": "admin",
  "POST /api/tasks/{id}/run": "admin",
  "POST /api/tasks/{id}/pause": "admin",
  "POST /api/tasks/{id}/resume": "admin",
  "GET /api/tasks/{id}/runs": "read",
  "POST /api/tasks/drain": "admin",
  "GET /api/ideas": "read",
  "POST /api/ideas/refresh": "chat",
  "POST /api/ideas/{id}/accept": "admin",
  "POST /api/ideas/{id}/dismiss": "chat",
  "GET /api/webhooks": "admin",
  "POST /api/tasks/wake": "admin",
  "POST /api/webhooks/{name}": "chat",
  "POST /api/webhooks": "admin",
  "DELETE /api/webhooks/{name}": "admin",
};

/** The scope a route needs; owner key for one the table does not know. */
export function scopeForRoute(method: string, path: string): HttpScope {
  return ROUTE_SCOPES[routeKey(method, path)] ?? "owner";
}
