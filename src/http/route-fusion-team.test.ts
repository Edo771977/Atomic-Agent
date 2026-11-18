import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as configuration from "../config/index.js";
import { createEmptySessionState, withSessionFusionReviewer } from "../session/index.js";
import { startTestHarness, type Harness } from "./test-harness.js";

/**
 * Issue #71: `GET /api/fusion/team` lists the fusion team with what each
 * member can do here, so the desktop's Director / Worker / Reviewer seats
 * draw only usable members and show the others disabled with the reason.
 */
describe("GET /api/fusion/team", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  function withTeam(): void {
    const config = configuration.loadConfig();
    config.llm = {
      activeTextProvider: "local-llama",
      activeEmbeddingProvider: "local-llama-embed",
      toolTransport: "auto",
      providers: [
        { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" },
        { id: "cloud-a", kind: "openai-compatible", baseUrl: "https://a.example.invalid/v1", apiKey: "k", defaultChatModel: "model-a" },
        { id: "codex", kind: "subscription-cli", subscriptionCli: { cli: "codex" }, defaultChatModel: "" },
      ],
      runMode: {
        mode: "fusion",
        fusion: {
          orchestratorProvider: "cloud-a",
          workerProvider: "local-llama",
          team: { directors: ["cloud-a:model-a"], workers: ["local-llama:model-l"], reviewers: ["codex:model-r", "cloud-a:model-o"] },
        },
      },
    } as never;
    vi.spyOn(configuration, "getConfig").mockReturnValue(config);
  }

  it("lists each role with usable and why, and the chat's choice for ?session=", async () => {
    withTeam();
    const session = { ...createEmptySessionState({ id: "s1", workingDir: harness.workingDir }), metadata: withSessionFusionReviewer({}, "none", 1) };
    harness.runtime.sessionStore.save(session);
    Object.assign(harness.runtime, {
      teamMemberReachable: () => true,
      providerRestrictionFor: (s: { id: string }) =>
        s.id === "s1" ? { label: "restricted to: cloud-a, local-llama", allowedProviders: ["cloud-a", "local-llama"], folder: "/f", readFrom: [], movedFrom: [] } : null,
    });
    const res = await fetch(`${harness.baseUrl}/api/fusion/team?session=s1`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      configured: true,
      mode: "fusion",
      directors: [{ ref: "cloud-a:model-a", usable: true }],
      workers: [{ ref: "local-llama:model-l", usable: true }],
      reviewers: [
        { ref: "codex:model-r", providerId: "codex", model: "model-r", usable: false, reason: "folder", why: "this folder (/f) does not allow codex" },
        { ref: "cloud-a:model-o", usable: true },
      ],
      chat: { session_id: "s1", director: null, worker: null, reviewer: "none" },
    });
    // Without a session: the server folder's restriction (none here), no chat.
    const plain = (await (await fetch(`${harness.baseUrl}/api/fusion/team`)).json()) as Record<string, unknown>;
    expect(plain).toMatchObject({ reviewers: [{ ref: "codex:model-r", usable: true }, { usable: true }] });
    expect(plain.chat).toBeUndefined();
  });

  it("says no team is configured, and 404s an unknown session", async () => {
    const res = await fetch(`${harness.baseUrl}/api/fusion/team`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configured: false, directors: [], workers: [], reviewers: [] });
    expect((await fetch(`${harness.baseUrl}/api/fusion/team?session=nope`)).status).toBe(404);
  });

  it("is advertised in /api/capabilities", async () => {
    const body = (await (await fetch(`${harness.baseUrl}/api/capabilities`)).json()) as { agent: Record<string, unknown> };
    expect(body.agent.fusionTeam).toEqual({ route: "/api/fusion/team", chatFields: ["director", "worker", "reviewer"] });
  });
});
