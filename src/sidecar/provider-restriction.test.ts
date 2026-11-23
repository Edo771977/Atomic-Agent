import { afterEach, expect, it, vi } from "vitest";
import * as bootstrap from "../runtime/bootstrap.js";
import * as configuration from "../config/index.js";
import { bootstrapSidecar } from "./main.js";

afterEach(() => vi.restoreAllMocks());

/**
 * Issue #33: `get_provider_restriction` answers like the HTTP route, with
 * `channelsAllowed` (the session's content may go to a chat channel or
 * phone push) on a restriction. The runtime side is stubbed.
 */
it("adds channelsAllowed to a session's restriction and keeps null for an unrestricted one", async () => {
  const config = configuration.loadConfig();
  config.llm = { activeTextProvider: "cloud", activeEmbeddingProvider: "cloud", toolTransport: "auto", providers: [{ id: "cloud", kind: "openai-compatible", baseUrl: "https://paid.invalid" }] };
  vi.spyOn(configuration, "getConfig").mockReturnValue(config);
  const restriction = { label: "restricted to: local-llama", allowedProviders: ["local-llama"], folder: "/work/secret", readFrom: [] };
  const sessions: Record<string, { id: string; workingDir: string }> = {
    chat: { id: "chat", workingDir: "/work/secret" },
    open: { id: "open", workingDir: "/work/open" },
    chan: { id: "chan", workingDir: "/work/chan" },
  };
  vi.spyOn(bootstrap, "createAgentRuntime").mockImplementation(async () => ({
    createSession: () => ({ id: "chat", workingDir: "/work/secret" }),
    shutdown: async () => {},
    sessionStore: { load: (id: string) => sessions[id] ?? null },
    providerRestrictionFor: (s: { id: string }) => (s.id === "open" ? null : restriction),
    egressRefusal: (s: { id: string }, cls: string) => (cls === "channels" && s.id === "chat" ? "folder /work/secret is restricted" : null),
  }) as unknown as bootstrap.AgentRuntime);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const streams = [process.stdin, process.stdin, process.stdout, process.stdout];
  const names = ["data", "end", "error", "close"];
  const kept = names.map((name, i) => streams[i]!.listeners(name));
  const sidecar = await bootstrapSidecar();
  const responses = new Map<string, { ok: boolean; payload: unknown }>();
  vi.spyOn(sidecar.protocol, "respond").mockImplementation((id, payload, ok = true) => {
    responses.set(id, { ok, payload });
    return { kind: "response", id: `response-${id}`, correlationId: id, ok, payload };
  });
  const send = (id: string, type: string, payload: unknown) =>
    process.stdin.emit("data", JSON.stringify({ kind: "request", id, type, payload }) + "\n");
  const response = async (id: string) => {
    await vi.waitFor(() => expect(responses.has(id)).toBe(true));
    return responses.get(id)!;
  };
  try {
    send("start", "start_session", { workingDir: process.cwd() });
    await response("start");
    send("a", "get_provider_restriction", { sessionId: "chat" });
    expect((await response("a")).payload).toEqual({ ...restriction, channelsAllowed: false });
    send("b", "get_provider_restriction", { sessionId: "chan" });
    expect((await response("b")).payload).toEqual({ ...restriction, channelsAllowed: true });
    send("c", "get_provider_restriction", { sessionId: "open" });
    expect((await response("c")).payload).toBeNull();
    send("d", "get_provider_restriction", { sessionId: "missing" });
    expect((await response("d")).payload).toBeNull();
  } finally {
    for (let i = 0; i < names.length; i++) {
      for (const listener of streams[i]!.listeners(names[i]!)) {
        if (!kept[i]!.includes(listener)) streams[i]!.removeListener(names[i]!, listener as () => void);
      }
    }
    await sidecar.shutdown();
  }
});
