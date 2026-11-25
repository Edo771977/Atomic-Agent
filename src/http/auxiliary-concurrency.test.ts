import { afterEach, expect, it, vi } from "vitest";
import { createHttpServer, type HttpServerHandle } from "./http-server.js";
import { buildRouteTable } from "./route-table.js";
import { hashHttpToken } from "./http-token-store.js";

let handle: HttpServerHandle | undefined;
afterEach(async () => { await handle?.close(); handle = undefined; });
const OWNER = "limit-owner";
const A = "limit-member-a";
const B = "limit-member-b";

async function fixture() {
  const releases: Array<() => void> = [];
  const complete = async (text: string) => {
    if (text === "hold") await new Promise<void>(resolve => { releases.push(resolve); });
    return { ok: true as const, text: "ok" };
  };
  handle = await createHttpServer({ host: "127.0.0.1", port: 0, apiKey: OWNER, routes: buildRouteTable(),
    namedTokens: () => [A, B].map((key, i) => ({ name: `member-${i}`, role: "member" as const, sha256: hashHttpToken(key), createdAt: "" })),
    runtime: { completePlain: (input: { prompt: string }) => complete(input.prompt), askSideQuestion: (question: string) => complete(question) } as never,
  });
  return { releases, post: (key: string, route: string, text: string) => fetch(`http://127.0.0.1:${handle!.port}/api/${route}`, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ prompt: text, question: text }),
  }) };
}

it.each(["complete", "btw"])("limits %s to two calls per token and releases settled calls", async route => {
  const f = await fixture();
  const pending = [f.post(A, route, "hold"), f.post(A, route, "hold")];
  await vi.waitFor(() => expect(f.releases).toHaveLength(2));
  try {
    const rejected = await f.post(A, route, "probe");
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("1");
    expect((await f.post(B, route, "probe")).status).toBe(200);
  } finally { f.releases.forEach(release => release()); await Promise.all(pending); }
  expect((await f.post(A, route, "probe")).status).toBe(200);
});

it("shares per-token and global limits between complete and btw, including the owner", async () => {
  const f = await fixture();
  const pending = [f.post(OWNER, "complete", "hold"), f.post(OWNER, "btw", "hold")];
  await vi.waitFor(() => expect(f.releases).toHaveLength(2));
  try {
    expect((await f.post(OWNER, "btw", "probe")).status).toBe(429);
    pending.push(f.post(A, "complete", "hold"), f.post(A, "btw", "hold"));
    await vi.waitFor(() => expect(f.releases).toHaveLength(4));
    expect((await f.post(B, "btw", "probe")).status).toBe(429);
    expect((await f.post(B, "complete", "probe")).status).toBe(429);
  } finally { f.releases.forEach(release => release()); await Promise.all(pending); }
  expect((await f.post(B, "complete", "probe")).status).toBe(200);
});
