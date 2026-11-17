import { describe, expect, it } from "vitest";

import { createSessionProviderPolicy } from "../session-provider-policy.js";
import { createOtlpSessionGate } from "./runtime-otlp-gate.js";

/** ATO-586 and issue #33 on upstream's OTLP span export (ATO-496). */
describe("createOtlpSessionGate", () => {
  const config = { projects: { roots: [], constraints: { "/work/secret": { allowedProviders: ["local-llama"] }, "/work/http-ok": { allowedProviders: ["local-llama"], allowedEgress: ["http"] } } } };
  const sessions: Record<string, { workingDir: string; metadata?: Record<string, unknown> }> = {
    "s-open": { workingDir: "/work/open" },
    "s-secret": { workingDir: "/work/secret" },
    "s-ok": { workingDir: "/work/http-ok" },
  };
  const policy = createSessionProviderPolicy({ readConfig: () => config, loadSession: (id) => sessions[id] ?? null });
  const gate = (tracesUrl: string) =>
    createOtlpSessionGate({ tracesUrl, isIncognito: (id) => id === "s-incognito", policy });

  it("holds back incognito chats, their side calls included, wherever the collector is", () => {
    for (const url of ["http://localhost:4318/v1/traces", "https://otel.example.com/v1/traces"]) {
      expect(gate(url)("s-incognito")).toBe(false);
      expect(gate(url)("reflection:s-incognito")).toBe(false);
      expect(gate(url)("s-open")).toBe(true);
    }
  });

  it("sends a constrained session to a remote collector only when its folder allows http", () => {
    const remote = gate("https://otel.example.com/v1/traces");
    expect(remote("s-secret")).toBe(false);
    expect(remote("s-ok")).toBe(true);
    // A loopback collector keeps the spans on this machine.
    expect(gate("http://127.0.0.1:4318/v1/traces")("s-secret")).toBe(true);
  });
});
