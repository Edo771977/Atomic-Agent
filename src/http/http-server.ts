import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

import type { AgentRuntime } from "../runtime/bootstrap.js";
import { ApprovalBus } from "./approval-bus.js";
import { ProjectGateBus } from "./project-gate-bus.js";
import { CompletionRegistry } from "./completion-registry.js";
import { openaiError } from "./openai-errors.js";
import { UndeliveredSteerStore } from "./undelivered-steers.js";
import { AuthThrottle } from "./auth-throttle.js";
import { enforceLoopbackGuard } from "./loopback-guard.js";
import { isNetworkListenHost, SERVE_RESTRICTED_CODE, SERVE_RESTRICTED_NOTICE, serveWithheld, serveWithheldRecord } from "./serve-egress.js";
import { sessionIdError } from "../session/session-id.js";
import { routeKey, scopeForRoute, type HttpScope } from "./http-scopes.js";
import type { StoredHttpToken } from "./http-token-store.js";
import { authorizeRequest } from "./scoped-auth.js";

/** ATO-1126: one per process; loopback callers are never counted. */
const authThrottle = new AuthThrottle();
import {
  BodyParseError,
  BodyTooLargeError,
  sendError,
  sendJson,
  type HandlerContext,
  type HttpHandler,
} from "./request-context.js";

export interface RouteDefinition {
  method: string;
  /**
   * Path template. Literal segments match verbatim; a segment of the
   * shape `{name}` is captured into `ctx.params[name]`. Trailing slashes
   * are ignored. Paths are matched against the request URL pathname
   * only — query strings are accessible via the raw `req`.
   */
  path: string;
  handler: HttpHandler;
  /**
   * Whether to enforce bearer-token auth when an `apiKey` is
   * configured. Defaults to `true`; set to `false` for `/health` and
   * `/v1/models` which OpenAI SDKs probe pre-auth.
   */
  requiresAuth?: boolean;
  /** ATO-583: the scope a named token needs here; defaults to the `ROUTE_SCOPES` entry. */
  scope?: HttpScope;
}

export interface HttpServerOptions {
  runtime: AgentRuntime;
  host: string;
  port: number;
  /**
   * The bearer key every authenticated route requires. `atomic-agent
   * serve` always passes one (its own, generated on the first run, when
   * the operator gives none). `null` turns the check off and is accepted
   * only together with `unauthenticated: true`.
   */
  apiKey: string | null;
  /**
   * The explicit opt-out for a server with no key: test harnesses and an
   * embedder that guards the port some other way. Without it a `null`
   * key is refused at construction, so no caller ends up keyless by
   * forgetting to pass one. A keyless server still runs the loopback
   * guard (ATO-1495).
   */
  unauthenticated?: boolean;
  routes: RouteDefinition[];
  approvalBus?: ApprovalBus;
  /** Issue #39: where the host publishes the runtime's `project_gate` events. */
  projectGateBus?: ProjectGateBus;
  completionRegistry?: CompletionRegistry;
  undeliveredSteers?: UndeliveredSteerStore;
  /**
   * Whether this listener counts as reachable from the network for the
   * per-folder `serve` refusal (issue #33). Default: a non-loopback
   * `host`. The webhook tunnel gateway sets it: it listens on loopback,
   * but cloudflared exposes it to the internet.
   */
  networkServe?: boolean;
  /** ATO-583: named tokens with roles, read per request (`createHttpTokenSource`). */
  namedTokens?: () => readonly StoredHttpToken[];
}

export interface HttpServerHandle {
  server: Server;
  host: string;
  port: number;
  approvalBus: ApprovalBus;
  projectGateBus: ProjectGateBus;
  completionRegistry: CompletionRegistry;
  /**
   * Steers the runtime accepted but no turn ever delivered. Exposed on
   * the handle so an embedder can drain or inspect them the same way it
   * can inspect pending approvals.
   */
  undeliveredSteers: UndeliveredSteerStore;
  close: () => Promise<void>;
}

interface CompiledRoute {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: HttpHandler;
  requiresAuth: boolean;
  key: string;
  scope: HttpScope;
}

/**
 * Pre-compile a path template like `/api/skills/{name}` into a regex
 * and the ordered list of named captures. Literal segments are
 * regex-escaped; `{name}` turns into a greedy-ish `[^/]+` capture.
 */
function compileRoute(route: RouteDefinition): CompiledRoute {
  const segments = route.path.split("/").filter((s) => s.length > 0);
  const paramNames: string[] = [];
  const parts = segments.map((segment) => {
    const match = /^\{([^}]+)\}$/.exec(segment);
    if (match?.[1]) {
      paramNames.push(match[1]);
      return "([^/]+)";
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  const pattern = new RegExp(`^/${parts.join("/")}/?$`);
  return {
    method: route.method.toUpperCase(),
    pattern,
    paramNames,
    handler: route.handler,
    requiresAuth: /^\/(?:api|v1)(?:\/|$)/.test(route.path) || route.requiresAuth !== false,
    key: routeKey(route.method, route.path),
    scope: route.scope ?? scopeForRoute(route.method, route.path),
  };
}

function matchRoute(
  routes: CompiledRoute[],
  method: string,
  pathname: string,
): { route: CompiledRoute; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const result = route.pattern.exec(pathname);
    if (!result) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, idx) => {
      const value = result[idx + 1];
      if (value !== undefined) params[name] = decodeURIComponent(value);
    });
    return { route, params };
  }
  return null;
}

/**
 * Start the HTTP server and return a handle. The caller owns the
 * lifecycle — call `handle.close()` on shutdown. All error handling is
 * funnelled through `openaiError` envelopes so clients see a uniform
 * error shape.
 */
export function createHttpServer(
  options: HttpServerOptions,
): Promise<HttpServerHandle> {
  if (options.apiKey === null && options.unauthenticated !== true) {
    return Promise.reject(
      new Error("createHttpServer: an API key is required (pass unauthenticated: true only in tests)"),
    );
  }
  if (options.apiKey !== null && options.apiKey.trim().length === 0) {
    return Promise.reject(new Error("createHttpServer: the API key is empty"));
  }
  const approvalBus = options.approvalBus ?? new ApprovalBus();
  const projectGateBus = options.projectGateBus ?? new ProjectGateBus();
  const completionRegistry =
    options.completionRegistry ?? new CompletionRegistry();
  const undeliveredSteers =
    options.undeliveredSteers ?? new UndeliveredSteerStore();
  const compiled = options.routes.map(compileRoute);
  const incognitoChats = new Set<string>();
  // Issue #33: on a network address, sessions of constrained folders
  // without "serve" are refused (serve-egress.ts).
  const networkServe = options.networkServe ?? isNetworkListenHost(options.host);

  const server = createServer(async (req, res) => {
    try {
      await dispatch(req, res, compiled, {
        runtime: options.runtime,
        apiKey: options.apiKey,
        approvalBus,
        projectGateBus,
        completionRegistry,
        undeliveredSteers,
        incognitoChats,
        networkServe,
      }, options.namedTokens);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  server.on("clientError", (_err, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
  });

  // Every open connection, so `close()` can wait for each to close
  // (`closeServer`).
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  return new Promise<HttpServerHandle>((resolvePromise, rejectPromise) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      rejectPromise(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      const resolvedPort =
        typeof address === "object" && address !== null
          ? address.port
          : options.port;
      resolvePromise({
        server,
        host: options.host,
        port: resolvedPort,
        approvalBus,
        projectGateBus,
        completionRegistry,
        undeliveredSteers,
        close: async () => {
          await closeServer(server, sockets);
          // ATO-586: the incognito chats this server opened. A chat whose
          // turn is still ending is deleted when it settles; one that
          // cannot be deleted now is the next start's sweep.
          for (const id of incognitoChats) {
            try {
              options.runtime.discardIncognitoSession?.(id);
            } catch {
              /* left for the boot sweep */
            }
          }
          incognitoChats.clear();
        },
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  routes: CompiledRoute[],
  baseCtx: Omit<HandlerContext, "params">,
  namedTokens?: () => readonly StoredHttpToken[],
): Promise<void> {
  const url = parseRequestUrl(req);
  if (!url) {
    sendError(res, 400, openaiError("Malformed request URL"));
    return;
  }
  // ATO-1495: a keyless (test-only) server refuses foreign Host/Origin and non-JSON bodies before routing.
  if (!enforceLoopbackGuard(req, res, baseCtx.apiKey)) return;
  const method = (req.method ?? "GET").toUpperCase();
  const matched = matchRoute(routes, method, url.pathname);
  if (!matched) {
    sendError(
      res,
      404,
      openaiError(
        `No route for ${method} ${url.pathname}`,
        "invalid_request_error",
      ),
    );
    return;
  }
  if (matched.route.requiresAuth && !authorizeRequest(req, res, {
    apiKey: baseCtx.apiKey,
    namedTokens,
    scope: matched.route.scope,
    route: matched.route.key,
  }, authThrottle)) {
    return;
  }
  const ctx: HandlerContext = { ...baseCtx, params: matched.params };
  // A session's own routes (transcript, export, steer, compaction, ...)
  // carry its content (issue #33).
  const sessionId = url.pathname.startsWith("/api/sessions/") ? matched.params.id : undefined;
  // Issue #74: a session id names files; refuse a path-like or control-character id before a handler sees it.
  const sessionIdProblem = sessionId === undefined ? null : sessionIdError(sessionId);
  if (sessionIdProblem !== null) {
    sendError(res, 400, openaiError(`Invalid session ID: ${sessionIdProblem}`, "invalid_request_error", "id"));
    return;
  }
  if (sessionId !== undefined && serveWithheld(ctx, sessionId)()) {
    sendError(res, 403, openaiError(SERVE_RESTRICTED_NOTICE, "permission_error", null, SERVE_RESTRICTED_CODE));
    return;
  }
  // Issue #74: a task's prompt, result and errors are its session's content.
  if (url.pathname.startsWith("/api/tasks/") && matched.params.id !== undefined && taskWithheld(ctx, matched.params.id)) {
    sendError(res, 403, openaiError(SERVE_RESTRICTED_NOTICE, "permission_error", null, SERVE_RESTRICTED_CODE));
    return;
  }
  await matched.route.handler(req, res, ctx);
}

/** A known task whose session this network server may not show; unknown ids fall through to the route's 404. */
function taskWithheld(ctx: HandlerContext, taskId: string): boolean {
  if (ctx.networkServe !== true) return false;
  let record: { sessionId: string | null } | null;
  try {
    record = ctx.runtime.taskStore.get(taskId);
  } catch {
    return false;
  }
  return record !== null && serveWithheldRecord(ctx, record.sessionId);
}

function parseRequestUrl(req: IncomingMessage): URL | null {
  const raw = req.url ?? "/";
  try {
    return new URL(raw, "http://localhost");
  } catch {
    return null;
  }
}

function handleRouteError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      // connection already torn down
    }
    return;
  }
  if (err instanceof BodyTooLargeError) {
    sendError(
      res,
      413,
      openaiError(
        err.message,
        "invalid_request_error",
        null,
        "payload_too_large",
      ),
    );
    return;
  }
  if (err instanceof BodyParseError) {
    sendError(res, 400, openaiError(err.message));
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(
    res,
    500,
    openaiError(`Internal server error: ${message}`, "server_error"),
  );
}

/**
 * How long `close()` waits for the connections it destroyed to report
 * closed. A destroyed socket always does, within a turn of the event
 * loop; this is only a backstop so teardown can never hang on one.
 */
const CLOSE_CONNECTIONS_BACKSTOP_MS = 1_000;

/**
 * Stop the server, and resolve once every connection it had has closed.
 *
 * `server.close()` calls back on the server's own 'close', which Node
 * emits on the next tick once `closeAllConnections()` has destroyed the
 * sockets — before any of those sockets has emitted its own 'close',
 * which comes later, from the handle's close callback. Each response's
 * 'close' rides its socket's, and that is what tells a running turn its
 * client is gone (`onClientGone` aborts it). `serve` shuts the runtime
 * down the moment this resolves, so resolving early meant the session
 * store closed while those turns had not even been told to stop, and a
 * turn cancelled by quitting the app lost its end. Waiting for every
 * socket's 'close' means every request has seen its connection go — and
 * aborted its turn — by the time the caller moves on.
 */
function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  if (!server.listening) return Promise.resolve();
  const open = [...sockets];
  return new Promise<void>((resolvePromise) => {
    let serverClosed = false;
    let pending = open.length;
    let backstop: ReturnType<typeof setTimeout> | undefined;
    const settle = (): void => {
      if (!serverClosed || pending > 0) return;
      clearTimeout(backstop);
      resolvePromise();
    };
    // Registered after each response's own 'close' listener, so by the
    // time this one runs the request has already been told.
    for (const socket of open) {
      socket.once("close", () => {
        pending -= 1;
        settle();
      });
    }
    server.close(() => {
      serverClosed = true;
      settle();
    });
    server.closeAllConnections?.();
    if (pending > 0) {
      backstop = setTimeout(() => {
        pending = 0;
        settle();
      }, CLOSE_CONNECTIONS_BACKSTOP_MS);
    }
  });
}
