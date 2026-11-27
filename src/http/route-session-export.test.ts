import { writeFileSync } from "node:fs";
import { join } from "node:path";

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetConfigCache, USER_CONFIG_VERSION } from "../config/index.js";
import { createEmptySessionState, type SessionState } from "../session/index.js";

import { startTestHarness, type Harness } from "./test-harness.js";

interface ExportBody {
  id: string;
  format: string;
  filename: string;
  mimeType: string;
  encoding: "utf8" | "base64";
  content: string;
}

describe("GET /api/sessions/{id}/export (ATO-1054)", () => {
  let harness: Harness;
  beforeEach(async () => { harness = await startTestHarness(); });
  afterEach(async () => { await harness.cleanup(); });

  const get = (id: string, query = "") => fetch(`${harness.baseUrl}/api/sessions/${id}/export${query}`);

  function seed(id: string): SessionState {
    const state: SessionState = {
      ...createEmptySessionState({ id, workingDir: harness.workingDir, metadata: { title: "Trip plan" } }),
      status: "completed",
      turns: [
        { kind: "user", text: "Plan a trip", at: 1 },
        { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "notes.md" }, at: 2 },
        { kind: "tool_result", tool: "os.fs.read", status: "ok", summary: "x", at: 3 },
        { kind: "assistant_reply", text: "Day 1: **Lisbon**", at: 4 },
      ],
      turnCount: 1,
      macroTurnStarts: [4],
    };
    harness.runtime.sessionStore.save(state);
    return state;
  }

  it("answers Markdown by default, with tool steps in words", async () => {
    seed("ex-1");
    const res = await get("ex-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ExportBody;
    expect(body).toMatchObject({ id: "ex-1", format: "markdown", filename: "Trip plan.md", encoding: "utf8" });
    expect(body.mimeType).toMatch(/^text\/markdown/);
    expect(body.content).toContain("# Trip plan");
    expect(body.content).toContain("Day 1: **Lisbon**");
    expect(body.content).toMatch(/\n- .+\n/);
    expect(body.content).not.toContain("- Used os.fs.read");
  });

  it.each(["md", "html", "docx", "pdf"])("bounds synchronous %s rendering for a 10,000-turn chat and oversized content", async format => {
    const state = seed("ex-large");
    state.turns = Array.from({ length: 10_000 }, () => ({ kind: "user" as const, text: "small", at: 1 }));
    harness.runtime.sessionStore.save(state);
    expect((await get(state.id, `?format=${format}`)).status).toBe(413);
    state.turns = [{ kind: "user", text: "x".repeat(1_000_001), at: 1 }];
    harness.runtime.sessionStore.save(state);
    const response = await get(state.id, `?format=${format}`);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "export_too_large" } });
  });

  it("leaves tool steps out with tools=0", async () => {
    seed("ex-2");
    const body = (await (await get("ex-2", "?tools=0")).json()) as ExportBody;
    expect(body.content).not.toMatch(/\n- /);
  });

  it("bounds total stored turns even when tool results are excluded", async () => {
    const state = seed("ex-total-turns");
    for (const count of [1_000, 10_000, 20_000]) {
      state.turns = [
        { kind: "user", text: "short question", at: 1 },
        ...Array.from({ length: count - 2 }, () => ({ kind: "tool_result" as const, tool: "os.fs.read", status: "ok" as const, summary: "omitted", at: 2 })),
        { kind: "assistant_reply", text: "short answer", at: 3 },
      ];
      harness.runtime.sessionStore.save(state);
      const started = performance.now();
      const response = await get(state.id, "?tools=0");
      expect(response.status).toBe(200);
      expect((await response.json() as ExportBody).content).toContain("short answer");
      expect(performance.now() - started).toBeLessThan(2_000);
    }
    state.turns.push({ kind: "tool_result", tool: "os.fs.read", status: "ok", summary: "one over", at: 4 });
    harness.runtime.sessionStore.save(state);
    for (const tools of [0, 1]) {
      const response = await get(state.id, `?tools=${tools}`);
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: { code: "export_too_large" } });
    }
  });

  it("budgets only the requested transcript with tools=0, excluding tool payloads and duplicated context", async () => {
    const state = seed("ex-projection");
    const ignored = "ignored context ".repeat(80_000);
    state.turns = [
      { kind: "user", text: "short question", at: 1 },
      ...Array.from({ length: 3_000 }, () => ({ kind: "assistant_tool_call" as const, tool: "os.fs.write", args: { path: "notes.md" }, at: 2 })),
      { kind: "tool_result", tool: "os.fs.write", status: "ok", summary: ignored, at: 3 },
      { kind: "assistant_reply", text: "short answer", at: 4 },
    ];
    state.cloudContext = { version: 1, turnsThrough: 0, boundaryHash: null, entries: [{ id: "copy", through: 0, turn: { kind: "user", text: ignored } }] };
    state.loadedSkills = [{ name: "fixture", version: "1", body: ignored, loadedAt: 1 }];
    harness.runtime.sessionStore.save(state);
    const response = await get(state.id, "?tools=0");
    expect(response.status).toBe(200);
    const body = await response.json() as ExportBody;
    expect(body.content).toContain("short answer");
    expect(body.content).not.toContain("ignored context");
    expect((await get(state.id, "?tools=1")).status).toBe(413);
    state.turns = [{ kind: "user", text: "x".repeat(1_000_001), at: 1 }];
    harness.runtime.sessionStore.save(state);
    expect((await get(state.id, "?tools=0")).status).toBe(413);
  });

  it("answers HTML, a base64 DOCX and a base64 PDF", async () => {
    seed("ex-3");
    const html = (await (await get("ex-3", "?format=html")).json()) as ExportBody;
    expect(html.encoding).toBe("utf8");
    expect(html.content).toContain("<strong>Lisbon</strong>");
    const docx = (await (await get("ex-3", "?format=docx")).json()) as ExportBody;
    expect(docx).toMatchObject({ format: "docx", filename: "Trip plan.docx", encoding: "base64" });
    const zip = await JSZip.loadAsync(Buffer.from(docx.content, "base64"));
    expect(await zip.file("word/document.xml")!.async("string")).toContain("Lisbon");
    const pdf = (await (await get("ex-3", "?format=pdf")).json()) as ExportBody;
    expect(pdf).toMatchObject({ format: "pdf", filename: "Trip plan.pdf", mimeType: "application/pdf", encoding: "base64" });
    expect(Buffer.from(pdf.content, "base64").subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
  });

  it("refuses an unknown format and a missing session", async () => {
    seed("ex-4");
    expect((await get("ex-4", "?format=rtf")).status).toBe(400);
    expect((await get("nope")).status).toBe(404);
  });

  it("does not put a credential from a command step in the export", async () => {
    const token = "abcd1234efgh5678wxyz";
    harness.runtime.sessionStore.save({
      ...createEmptySessionState({ id: "exp-secret", workingDir: harness.workingDir }),
      status: "completed",
      turns: [
        { kind: "user", text: "check the API", at: 1 },
        {
          kind: "assistant_tool_call",
          tool: "os.shell.run",
          args: { command: `curl -H "Authorization: Bearer ${token}" x` },
          at: 2,
        },
        { kind: "tool_result", tool: "os.shell.run", status: "ok", summary: "x", at: 3 },
        { kind: "assistant_reply", text: "done", at: 4 },
      ],
    });
    const res = await get("exp-secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ExportBody;
    expect(body.content).toContain("curl");
    expect(body.content).not.toContain(token);
  });

  it("masks a provider key stored in config.json (ATO-1077 set), not only the .env ones", async () => {
    const key = "9f3c2a7e81d4b06f5ac39e72d18b4f60";
    writeFileSync(
      join(harness.stateDir, "config.json"),
      JSON.stringify({
        version: USER_CONFIG_VERSION,
        llm: {
          activeTextProvider: "local-llama",
          providers: [
            { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" },
            { id: "cloud", kind: "aimlapi", apiKey: key, defaultChatModel: "m" },
          ],
        },
      }),
    );
    resetConfigCache();
    harness.runtime.sessionStore.save({
      ...createEmptySessionState({ id: "exp-cfg-key", workingDir: harness.workingDir }),
      status: "completed",
      turns: [
        { kind: "user", text: "check", at: 1 },
        { kind: "assistant_tool_call", tool: "os.shell.run", args: { command: `printf %s ${key}` }, at: 2 },
        { kind: "tool_result", tool: "os.shell.run", status: "ok", summary: "x", at: 3 },
        { kind: "assistant_reply", text: "done", at: 4 },
      ],
    });
    const body = (await (await get("exp-cfg-key")).json()) as ExportBody;
    expect(body.content).toContain("printf");
    expect(body.content).not.toContain(key);
  });

  it.each(["md", "pdf"])("refuses an incognito chat with 409 in %s", async format => {
    const state = seed("exp-incog");
    harness.runtime.sessionStore.save({ ...state, incognito: harness.runtime.sessionStore.newIncognitoMark() });
    const res = await get("exp-incog", `?format=${format}`);
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toMatch(/incognito/);
  });
});

