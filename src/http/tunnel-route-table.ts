import type { RouteDefinition } from "./http-server.js";
import { createWebhookHandler } from "./route-webhooks.js";
import { TUNNEL_WEBHOOK_PREFIX } from "./webhook-tunnel-status.js";

/**
 * The cloudflared listener only handles webhook deliveries. All deliveries
 * need the binding's secret or signature and share replay protection.
 * API clients also send the serve key on the /api path. Providers that
 * cannot add a bearer header use the dedicated /webhooks path.
 */
export function buildTunnelRouteTable(): RouteDefinition[] {
  const handler = createWebhookHandler({ requireSecret: true, dedupeDeliveries: true });
  return [
    { method: "POST", path: "/api/webhooks/{name}", handler },
    { method: "POST", path: `${TUNNEL_WEBHOOK_PREFIX}/{name}`, handler, requiresAuth: false },
  ];
}
