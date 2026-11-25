import { afterEach, expect, it, vi } from "vitest";
import { createHttpServer, type HttpServerHandle } from "./http-server.js";
import { buildRouteTable } from "./route-table.js";
import { hashHttpToken } from "./http-token-store.js";
let h: HttpServerHandle | undefined;
afterEach(async () => { await h?.close(); });
it.each(["complete", "btw"])("admits owner %s when two members occupy all four named inference slots", async route => {
  const releases: Array<() => void> = [];
  const run = async (prompt: string) => {
    if (prompt === "hold") await new Promise<void>(r => { releases.push(r); });
    return { ok: true, text: "ok" };
  };
  h = await createHttpServer({ host: "127.0.0.1", port: 0, apiKey: "owner", routes: buildRouteTable(), namedTokens: () => ["a", "b", "c"].map(name => ({ name, role: "member" as const, sha256: hashHttpToken(name), createdAt: "" })), runtime: { completePlain: (input: { prompt: string }) => run(input.prompt), askSideQuestion: run } as never });
  const post = (token: string, prompt: string) => fetch(`http://127.0.0.1:${h!.port}/api/${route}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ prompt, question: prompt }) });
  const pending = [post("a", "hold"), post("a", "hold"), post("b", "hold"), post("b", "hold")];
  await vi.waitFor(() => expect(releases).toHaveLength(4));
  try {
    expect((await post("owner", "probe")).status).toBe(200);
    expect((await post("a", "probe")).status).toBe(429);
    expect((await post("c", "probe")).status).toBe(429);
  } finally { releases.forEach(release => release()); await Promise.all(pending); }
  expect((await post("c", "probe")).status).toBe(200);
});
