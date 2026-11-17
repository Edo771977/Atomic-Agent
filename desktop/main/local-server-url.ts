/**
 * Whether an OpenAI-compatible base URL points at a server on this
 * machine or the local network (llama-server, vLLM, LM Studio and the
 * like): loopback, RFC 1918, link-local and CGNAT/Tailscale (100.64/10) IPv4, IPv6 unique-local and
 * link-local, own-network names (`.local`, `.lan`, `.internal`,
 * `.home.arpa`, `.home`, `.localdomain`, `.corp`, `.intranet`, Tailscale
 * `.ts.net`), nip.io / sslip.io names judged by the address they spell,
 * and single-label hosts. Lexical only: no DNS lookup is made. Such
 * servers render the chat template themselves and take its arguments
 * (`chat_template_kwargs`); public endpoints may reject a field they do
 * not know, so they are never treated as local.
 *
 * A copy of the agent's src/llm/provider/openai/local-server-url.ts and
 * of `classifiableHostOf` in src/llm/provider/url-host.ts (the desktop's
 * main process does not import from src/); test/folder-provider-hosts.test.mjs
 * compares the two. Keep them alike.
 */
export function isLocalServerUrl(url: string | undefined): boolean {
  const host = classifiableHostOf(url);
  if (host === null) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0" || host === "::") return true;
  const v4 = host.split(".");
  if (v4.length === 4 && v4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    const [a, b] = v4.map(Number) as [number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) ||
      // Carrier-grade NAT, 100.64.0.0/10 (Tailscale).
      (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(":")) return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
  if (!host.includes(".")) return true;
  const wildcard = WILDCARD_DNS_SUFFIXES.find((suffix) => host.endsWith(suffix));
  if (wildcard) {
    const inside = wildcardDnsIpv4(host.slice(0, -wildcard.length));
    return inside === null || isLocalServerUrl(`http://${inside}`);
  }
  return OWN_NETWORK_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

const OWN_NETWORK_SUFFIXES = [
  ".local", ".lan", ".internal", ".home.arpa", ".home", ".localdomain", ".corp", ".intranet", ".ts.net",
] as const;

const WILDCARD_DNS_SUFFIXES = [".nip.io", ".sslip.io"] as const;

/** The IPv4 address a nip.io / sslip.io name spells before its suffix, or `null`. */
function wildcardDnsIpv4(prefix: string): string | null {
  const labels = prefix.split(".");
  const dotted = labels.slice(-4);
  if (dotted.length === 4 && dotted.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return dotted.join(".");
  }
  const last = labels[labels.length - 1] ?? "";
  const dashed = /(?:^|-)(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})$/.exec(last);
  if (dashed && dashed.slice(1).every((part) => Number(part) <= 255)) return dashed.slice(1).join(".");
  const hex = /(?:^|-)([0-9a-f]{8})$/.exec(last);
  if (hex) {
    const value = parseInt(hex[1]!, 16);
    return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
  }
  return null;
}

/**
 * The host of a URL as the classifiers compare it: lower case, no IPv6
 * brackets, one trailing dot removed, and an IPv6 address that embeds an
 * IPv4 one replaced by that address. `null` when the URL does not parse
 * or has no host.
 */
function classifiableHostOf(url: string | undefined): string | null {
  if (!url) return null;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host.length === 0) return null;
  return embeddedIpv4(host) ?? host;
}

/** IPv4-mapped, IPv4-translated, NAT64, IPv4-compatible and 6to4 forms → the IPv4 address inside, else `null`. */
function embeddedIpv4(host: string): string | null {
  const g = expandIpv6(host);
  if (g === null) return null;
  const zero = (from: number, to: number) => g.slice(from, to).every((part) => part === 0);
  const v4 = (high: number, low: number) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  if (zero(0, 5) && g[5] === 0xffff) return v4(g[6]!, g[7]!);
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6]!, g[7]!);
  if (zero(0, 6) && g[6] !== 0) return v4(g[6]!, g[7]!);
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!);
  return null;
}

/** The eight 16-bit groups of an IPv6 address (a dotted IPv4 tail allowed), or `null`. */
function expandIpv6(host: string): number[] | null {
  if (!host.includes(":")) return null;
  let text = host;
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const b = tail.slice(1).map(Number);
    if (b.some((part) => part > 255)) return null;
    text = `${text.slice(0, tail.index)}${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part.length === 0 ? [] : part.split(":"));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  if (!groups.every((part) => /^[0-9a-f]{1,4}$/.test(part))) return null;
  return groups.map((part) => parseInt(part, 16));
}
