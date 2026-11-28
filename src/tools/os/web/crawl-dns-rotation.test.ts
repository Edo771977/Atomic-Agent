import { describe, expect, it } from "vitest";
import { USER_CONFIG_DEFAULTS } from "../../../config/index.js";
import type { runCommand as RunCommand } from "../../../sandbox/command-runner.js";
import { buildOsWebCrawlTool } from "./web-crawl.js";

const origin = "https://docs.example.com";
const ipv4 = ["93.184.216.34", "8.8.8.8", "1.1.1.1"];
const ipv6 = "2606:4700:4700::1111";
const context = () => ({ workingDir: process.cwd(), sessionId: "dns-rotation", stepIndex: 0, signal: new AbortController().signal });

function fixture(answers: readonly (readonly string[])[], retries = 0) {
  let lookups = 0;
  let pageAttempts = 0;
  const requests: { url: string; pin: string }[] = [];
  const dnsAnswers: string[][] = [];
  const runCommand = (async (_command: string, args: string[]) => {
    const url = args.at(-1)!;
    requests.push({ url, pin: args[args.indexOf("--resolve") + 1]! });
    const robots = url.endsWith("/robots.txt");
    const status = !robots && retries > 0 && pageAttempts++ === 0 ? 503 : 200;
    const body = robots ? "User-agent: *\nAllow: /" : `<html><main>Public documentation <a href="/a">A</a><a href="/b">B</a></main></html>`;
    return { command: "curl", args, exitCode: 0, signal: null, stdout: `${body}\n__ATOMIC_WEBFETCH_META__${status}|${robots ? "text/plain" : "text/html"}||0|{}`, stderr: "", durationMs: 1, timedOut: false, truncated: false, inputTruncated: false };
  }) as typeof RunCommand;
  const tool = buildOsWebCrawlTool({
    runCommand,
    lookup: async () => {
      const answer = [...answers[Math.min(lookups++, answers.length - 1)]!];
      dnsAnswers.push(answer);
      return answer.map(address => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    sleep: async () => {},
    config: { web: { ...USER_CONFIG_DEFAULTS.web, fetch: { ...USER_CONFIG_DEFAULTS.web.fetch, maxRetries: retries } } },
  });
  return { tool, requests, dnsAnswers };
}

describe("same-host crawl DNS rotation", () => {
  it("matches main on three rotating public IPv4 addresses for three pages", async () => {
    const f = fixture([[ipv4[0]!], [ipv4[1]!], [ipv4[2]!], [ipv4[0]!], [ipv4[1]!]]);
    const result = await f.tool.run({ url: origin, maxPages: 3, maxDepth: 1, useSitemap: false }, context());
    expect(result.status).toBe("ok");
    expect(result.details.pages).toHaveLength(3);
    expect(f.requests.map(x => x.url)).toEqual([origin + "/robots.txt", origin + "/", origin + "/a", origin + "/b"]);
    expect(f.requests.map(x => x.pin)).toEqual([ipv4[1], ipv4[2], ipv4[0], ipv4[1]].map(ip => `docs.example.com:443:${ip}`));
    expect(f.dnsAnswers).toHaveLength(5);
  });

  it("matches main when public IPv4 gains IPv6 for two pages", async () => {
    const f = fixture([[ipv4[0]!], [ipv4[0]!], [ipv4[0]!, ipv6]]);
    const result = await f.tool.run({ url: origin, maxPages: 2, maxDepth: 1, useSitemap: false }, context());
    expect(result.status).toBe("ok");
    expect(result.details.pages).toHaveLength(2);
    expect(f.requests.map(x => x.pin)).toEqual([
      `docs.example.com:443:${ipv4[0]}`,
      `docs.example.com:443:${ipv4[0]},[${ipv6}]`,
      `docs.example.com:443:${ipv4[0]},[${ipv6}]`,
    ]);
  });

  it("revalidates and repins public DNS on a same-host retry", async () => {
    const f = fixture([[ipv4[0]!], [ipv4[1]!], [ipv4[2]!], [ipv4[0]!]], 1);
    expect((await f.tool.run({ url: origin, maxDepth: 0, useSitemap: false }, context())).status).toBe("ok");
    expect(f.requests.map(x => x.pin)).toEqual([ipv4[1], ipv4[2], ipv4[0]].map(ip => `docs.example.com:443:${ip}`));
  });

  it("revalidates cached same-host pages while allowing public rotation", async () => {
    const f = fixture([[ipv4[0]!], [ipv4[0]!], [ipv4[0]!], [ipv4[1]!], [ipv4[2]!]]);
    const args = { url: origin, maxDepth: 0, useSitemap: false };
    expect((await f.tool.run(args, context())).status).toBe("ok");
    expect((await f.tool.run(args, context())).status).toBe("ok");
    expect(f.requests).toHaveLength(2);
    expect(f.dnsAnswers.length).toBeGreaterThan(4);
  });

  it.each(["127.0.0.1", "169.254.169.254", "::1", "10.0.0.7"])("rejects an entire mixed DNS answer containing %s before a derived page", async privateIp => {
    const f = fixture([[ipv4[0]!], [ipv4[0]!], [ipv4[0]!], [ipv4[1]!, privateIp]]);
    const result = await f.tool.run({ url: origin, maxDepth: 1, useSitemap: false }, context());
    expect(result.details.pages).toHaveLength(1);
    expect(result.details.errors).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("private/internal") })]));
    expect(f.requests.map(x => x.url)).toEqual([origin + "/robots.txt", origin + "/"]);
  });

  it("revalidates all DNS answers before a cached page is reused", async () => {
    const f = fixture([[ipv4[0]!], [ipv4[0]!], [ipv4[0]!], [ipv4[0]!], [ipv4[0]!, "127.0.0.1"]]);
    const args = { url: origin, maxDepth: 0, useSitemap: false };
    expect((await f.tool.run(args, context())).status).toBe("ok");
    const result = await f.tool.run(args, context());
    expect(result.status).toBe("error");
    expect(result.details.errors).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("private/internal") })]));
    expect(f.requests).toHaveLength(2);
  });

  it("refuses a private DNS answer before retry transport", async () => {
    const f = fixture([[ipv4[0]!], [ipv4[0]!], [ipv4[0]!], [ipv4[0]!, "169.254.169.254"]], 1);
    expect((await f.tool.run({ url: origin, maxDepth: 0, useSitemap: false }, context())).status).toBe("error");
    expect(f.requests.map(x => x.url)).toEqual([origin + "/robots.txt", origin + "/"]);
  });
});
