import { domainToASCII } from "node:url";

function parsedWeb(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.hostname.endsWith(".")) url.hostname = url.hostname.slice(0, -1);
    return url;
  } catch { return null; }
}

export function canonicalWebEndpoint(value: string): string {
  return parsedWeb(value)?.href ?? value;
}

export function normalizeWebPattern(value: string, originShorthand = true): string {
  if (/^https?:\/\//i.test(value)) {
    const url = parsedWeb(value);
    if (url === null) return value;
    if (originShorthand) { url.username = ""; url.password = ""; }
    return originShorthand && /^https?:\/\/[^/?#]+$/i.test(value) ? url.origin : url.href;
  }
  // Bare host patterns select every scheme/path, retaining an explicit port.
  if (!/[\/\s]/.test(value)) {
    const port = value.match(/:(\d+)$/)?.[0] ?? "";
    const host = port ? value.slice(0, -port.length) : value;
    return (domainToASCII(host.replace(/\.$/, "")) || host).toLowerCase() + port;
  }
  return value;
}

export function webResourceForms(value: string): string[] {
  const url = parsedWeb(value);
  if (url === null) return [normalizeWebPattern(value)];
  url.username = ""; url.password = "";
  return [...new Set([url.href, url.origin, url.host, url.hostname, `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`])];
}
