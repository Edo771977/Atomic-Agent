/**
 * What `atag serve --tunnel` is doing right now (ATO-625), for
 * `GET /api/webhooks`. One serve process runs at most one tunnel, so the
 * state is process-wide; serve writes it, the route only reads it.
 *
 * `publicUrl` is the tunnel's origin (`https://<name>.trycloudflare.com`
 * or the named tunnel's hostname); the webhook address is that plus
 * `/webhooks/<name>`. The API webhook path also exists with bearer auth.
 */
export interface WebhookTunnelStatus {
  state: "off" | "starting" | "up" | "failed";
  mode: "quick" | "named" | null;
  publicUrl: string | null;
  error: string | null;
}

export const TUNNEL_WEBHOOK_PREFIX = "/webhooks";

export function webhookTunnelPath(name: string): string {
  return `${TUNNEL_WEBHOOK_PREFIX}/${encodeURIComponent(name)}`;
}

const OFF: WebhookTunnelStatus = {
  state: "off",
  mode: null,
  publicUrl: null,
  error: null,
};

let current: WebhookTunnelStatus = OFF;

export function getWebhookTunnelStatus(): WebhookTunnelStatus {
  return current;
}

export function setWebhookTunnelStatus(next: WebhookTunnelStatus): void {
  current = { ...next };
}

export function resetWebhookTunnelStatus(): void {
  current = OFF;
}
