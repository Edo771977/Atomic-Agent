import * as backupService from "../memory/memory-backup.js";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpServer } from "./http-server.js";
import { createMemoryBackupHandler } from "./route-memory-operator.js";
import { hashHttpToken } from "./http-token-store.js";
import { startTestHarness, type Harness } from "./test-harness.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("operator memory routes", () => {
  let harness: Harness;
  let noteId: number;
  const tokens = [
    { name: "test-admin", role: "admin" as const, sha256: hashHttpToken("admin-test-token"), createdAt: new Date(0).toISOString() },
    { name: "test-viewer", role: "viewer" as const, sha256: hashHttpToken("viewer-test-token"), createdAt: new Date(0).toISOString() },
  ];
  beforeEach(async () => {
    harness = await startTestHarness({ apiKey: "owner-test-token", namedTokens: () => tokens });
    noteId = harness.runtime.notesStore.store({ content: "Visible note" }).id;
    harness.runtime.profileStore.set("city", "Rome");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  const send = (path: string, body?: unknown, token = "admin-test-token", extras: Record<string, string> = {}) =>
    fetch(harness.baseUrl + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...extras,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it.each(["note", "profile", "backup"] as const)("enforces auth, request policy and idle mode for %s", async (kind) => {
    const path = kind === "note" ? `/api/memory/notes/${noteId}/state`
      : kind === "profile" ? "/api/memory/profile/city/state" : "/api/memory/backup";
    const body = kind === "backup" ? {} : { enabled: false, fingerprint: "0".repeat(64) };
    expect((await send(path, body, "")).status).toBe(401);
    expect((await send(path, body, "viewer-test-token")).status).toBe(403);
    expect((await send(path, body, undefined, { origin: "https://untrusted.example" })).status).toBe(403);
    expect((await send(path, body, undefined, { "content-type": "text/plain" })).status).toBe(415);
    const busy = vi.spyOn(harness.runtime.turnController, "busySessionIds").mockReturnValue(["running"]);
    const refused = await send(path, body);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "turn-running" } });
    busy.mockRestore();
    const incognito = vi.spyOn(harness.runtime, "anyIncognitoOpen").mockReturnValue(true);
    const privateResponse = await send(path, body);
    expect(privateResponse.status).toBe(409);
    expect(await privateResponse.json()).toMatchObject({ error: { code: "incognito" } });
    incognito.mockRestore();
    if (kind !== "backup") {
      const stale = await send(path, body);
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: { code: "stale-view" } });
    }
  });

  it.each(["note", "profile"] as const)("updates and journals %s and publishes a bounded SSE event", async (kind) => {
    const list = kind === "note" ? "/api/memory/notes" : "/api/memory/profile";
    const path = kind === "note" ? `/api/memory/notes/${noteId}/state` : "/api/memory/profile/city/state";
    const key = kind === "note" ? "notes" : "facts";
    const before = await (await send(list, undefined, "viewer-test-token")).json() as Record<string, { fingerprint: string }[]>;
    const last = before[key]?.[0];
    expect(last?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const abort = new AbortController();
    const events = await fetch(harness.baseUrl + "/api/events", {
      headers: { authorization: "Bearer viewer-test-token" }, signal: abort.signal,
    });
    const reader = events.body!.getReader();
    try {
      const changed = await send(path, { enabled: false, fingerprint: last!.fingerprint });
      expect(changed.status).toBe(200);
      const result = await changed.json();
      expect((await send(path, { enabled: true, fingerprint: last!.fingerprint })).status).toBe(409);
      expect(result).toEqual({ enabled: false, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
      const event = new TextDecoder().decode((await reader.read()).value);
      expect(event).toContain("event: memory_state_changed");
      expect(event).toContain("data: {}");
      expect(event).not.toContain("Visible note");
      expect(event).not.toContain("Rome");
      expect(await (await send(list)).json()).toMatchObject({ [key]: [{ enabled: false }] });
      const entry = harness.runtime.notesStore.getChangeLog().list()[0]!;
      expect(entry.op).toBe("set_disabled");
      expect(entry.by).toBe("user");
      expect((await send(`/api/memory/changes/${entry.id}/restore`, {})).status).toBe(200);
      expect(await (await send(list)).json()).toMatchObject({ [key]: [{ enabled: true }] });
    } finally {
      abort.abort();
      await reader.cancel().catch(() => {});
    }
  });

  it("redacts legacy credentials and neutralizes invisible characters in lists", async () => {
    const db = harness.runtime.notesStore.getDatabaseHandleForEmbeddings();
    db.prepare("UPDATE memories SET tags = ? WHERE id = ?").run(JSON.stringify(["password: test-secret"]), noteId);
    harness.runtime.notesStore.store({ content: "left\u202eright" });
    db.prepare("UPDATE profile_facts SET key = 'pin', value = '4821' WHERE key = 'city'").run();
    const notes = await (await send("/api/memory/notes")).text();
    expect(notes).toContain("202E");
    expect(notes).not.toContain("\u202e");
    expect(notes).not.toContain("test-secret");
    expect(await (await send("/api/memory/profile", undefined, "viewer-test-token")).json()).toEqual({ facts: [] });
    harness.runtime.profileStore.remove("pin", "user");
    expect(await (await send("/api/memory/changes")).text()).not.toContain("4821");
  });

  it("allows a backup again after deleting an incognito chat", async () => {
    const response = await send("/v1/chat/completions", {
      model: "atomic-agent", messages: [{ role: "user", content: "hello" }], incognito: true,
    });
    expect(response.status).toBe(200);
    const { session_id: id } = await response.json() as { session_id: string };
    expect(id).toBeTruthy();
    const blocked = await send("/api/memory/backup", {});
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "incognito" } });
    const deleted = await fetch(harness.baseUrl + `/api/sessions/${id}`, {
      method: "DELETE", headers: { authorization: "Bearer admin-test-token" },
    });
    expect(deleted.status).toBe(200);
    expect(await send("/api/memory/backup", {})).toHaveProperty("status", 200);
  });

  it("keeps a deferred incognito deletion tracked until the row is gone", async () => {
    const response = await send("/v1/chat/completions", {
      model: "atomic-agent", messages: [{ role: "user", content: "hello" }], incognito: true,
    });
    expect(response.status).toBe(200);
    const { session_id: id } = await response.json() as { session_id: string };
    // Exercise the HTTP tracking independently of the runtime's live-chat guard.
    vi.spyOn(harness.runtime, "anyIncognitoOpen").mockReturnValue(false);
    const discard = vi.spyOn(harness.runtime, "discardIncognitoSession").mockReturnValueOnce("deferred");
    const deleted = await fetch(harness.baseUrl + "/api/sessions/" + id, {
      method: "DELETE", headers: { authorization: "Bearer admin-test-token" },
    });
    expect(deleted.status).toBe(200);
    expect(discard).toHaveBeenCalledWith(id);
    const blocked = await send("/api/memory/backup", {});
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "incognito" } });

    harness.runtime.sessionStore.delete(id);
    expect((await send("/api/memory/backup", {})).status).toBe(200);
    // A second idle assertion must no longer consult that stale tracked ID.
    const load = vi.spyOn(harness.runtime.sessionStore, "load");
    const note = (await (await send("/api/memory/notes")).json() as { notes: { fingerprint: string }[] }).notes[0]!;
    expect((await send("/api/memory/notes/" + noteId + "/state", { enabled: false, fingerprint: note.fingerprint })).status).toBe(200);
    expect(load).not.toHaveBeenCalledWith(id);
  });

  it.each([
    ["backup-exists", 409], ["contains-credential", 422], ["no-database", 422],
  ] as const)("maps backup refusals to stable codes: %s", async (code, status) => {
    vi.spyOn(backupService, "createMemoryBackup")
      .mockRejectedValueOnce(new backupService.MemoryBackupError("private detail for test", code));
    const response = await send("/api/memory/backup", {});
    expect(response.status).toBe(status);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code } });
    expect(body).not.toContain("private detail");
  });

  it("allows only one HTTP backup in flight", async () => {
    const actual = backupService.createMemoryBackup;
    const started = deferred();
    const resume = deferred();
    vi.spyOn(backupService, "createMemoryBackup").mockImplementationOnce(async (...args) => {
      started.resolve();
      await resume.promise;
      return actual(...args);
    });
    const first = send("/api/memory/backup", {});
    await started.promise;
    try {
      const second = await send("/api/memory/backup", {});
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ error: { code: "backup-running" } });
    } finally {
      resume.resolve();
      expect((await first).status).toBe(200);
    }
  });

  it("logs unexpected backup errors without sensitive details", async () => {
    const logger = vi.spyOn(harness.runtime.logger, "error");
    vi.spyOn(backupService, "createMemoryBackup").mockRejectedValueOnce(Object.assign(new Error("private detail for test"), { code: "EACCES", errno: -13, path: "/private/test-path" }));
    const response = await send("/api/memory/backup", {});
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private detail");
    expect(logger).toHaveBeenCalledWith("Memory operator request failed", {
      method: "POST", route: "/api/memory/backup", errorName: "Error", code: "EACCES", errno: -13,
    });
    expect(JSON.stringify(logger.mock.calls)).not.toContain("/private/test-path");
    expect(JSON.stringify(logger.mock.calls)).not.toContain("private detail");
  });

  it("allows an immediate retry after an HTTP backup fails before publishing", async () => {
    vi.spyOn(backupService, "createMemoryBackup").mockRejectedValueOnce(new Error("disk failure"));
    expect((await send("/api/memory/backup", {})).status).toBe(500);
    expect((await send("/api/memory/backup", {})).status).toBe(200);
  });

  async function seedHttpBackups(count: number): Promise<string> {
    const root = join(harness.runtime.config.paths.stateDir, "backups");
    for (let index = 0; index < count; index += 1) {
      const dir = join(root, "memory-20261124-120000-00000000-0000-4000-8000-" + String(index).padStart(12, "0"));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, backupService.MEMORY_BACKUP_FILE), "");
    }
    return root;
  }

  it("refuses to retain more than twenty HTTP backups", async () => {
    const root = await seedHttpBackups(20);
    const response = await send("/api/memory/backup", {});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "backup-limit" } });
    expect(await readdir(root)).toHaveLength(20);
  });

  it("enforces the retained backup cap at publication across listeners", async () => {
    const root = await seedHttpBackups(19);
    const second = await createHttpServer({
      runtime: harness.runtime, apiKey: "owner-test-token", host: "127.0.0.1", port: 0,
      routes: [{ method: "POST", path: "/api/memory/backup", handler: createMemoryBackupHandler() }],
    });
    const rendezvous = deferred();
    const create = backupService.createMemoryBackup;
    let started = 0;
    vi.spyOn(backupService, "createMemoryBackup").mockImplementation(async (...args) => {
      if (++started === 2) rendezvous.resolve();
      await rendezvous.promise;
      return create(...args);
    });
    try {
      const [first, other] = await Promise.all([
        send("/api/memory/backup", {}),
        fetch("http://127.0.0.1:" + second.port + "/api/memory/backup", {
          method: "POST", headers: { authorization: "Bearer owner-test-token", "content-type": "application/json" }, body: "{}",
        }),
      ]);
      expect([first.status, other.status].sort()).toEqual([200, 409]);
      expect(await (first.status === 409 ? first : other).json()).toMatchObject({ error: { code: "backup-limit" } });
      expect(await readdir(root)).toHaveLength(20);
    } finally {
      rendezvous.resolve();
      await second.close();
    }
  });

  it("limits the frequency of HTTP backup attempts", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    expect((await send("/api/memory/backup", {})).status).toBe(200);
    const limited = await send("/api/memory/backup", {});
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: "backup-cooldown" } });
    now.mockReturnValue(61_000);
    expect((await send("/api/memory/backup", {})).status).toBe(200);
  });

  it("guards an undo of a memory toggle and emits a refresh", async () => {
    harness.runtime.notesStore.setDisabled(noteId, true);
    const entry = harness.runtime.notesStore.getChangeLog().list()[0]!;
    const path = `/api/memory/changes/${entry.id}/restore`;
    const busy = vi.spyOn(harness.runtime.turnController, "busySessionIds").mockReturnValue(["running"]);
    const blocked = await send(path, {});
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "turn-running" } });
    busy.mockRestore();
    const privateMode = vi.spyOn(harness.runtime, "anyIncognitoOpen").mockReturnValue(true);
    const privateResult = await send(path, {});
    expect(privateResult.status).toBe(409);
    expect(await privateResult.json()).toMatchObject({ error: { code: "incognito" } });
    privateMode.mockRestore();
    expect(harness.runtime.notesStore.get(noteId)?.disabledAt).toBeDefined();

    const abort = new AbortController();
    const events = await fetch(harness.baseUrl + "/api/events", {
      headers: { authorization: "Bearer viewer-test-token" }, signal: abort.signal,
    });
    const reader = events.body!.getReader();
    try {
      expect((await send(path, {})).status).toBe(200);
      const event = new TextDecoder().decode((await reader.read()).value);
      expect(event).toContain("event: memory_state_changed");
      expect(event).toContain("data: {}");
      expect(harness.runtime.notesStore.get(noteId)?.disabledAt).toBeUndefined();
    } finally {
      abort.abort();
      await reader.cancel().catch(() => {});
    }
  });

  it("keeps secret facts and invisible profile keys deletable by reference", async () => {
    const db = harness.runtime.notesStore.getDatabaseHandleForEmbeddings();
    const hidden = harness.runtime.profileStore.set("hidden", "Clean text");
    const invisible = "left\u202eright";
    db.prepare("UPDATE profile_facts SET key = ? WHERE id = ?").run(invisible, hidden.id);
    db.prepare("UPDATE profile_facts SET key = 'pin', value = '4821' WHERE key = 'city'").run();
    for (const token of ["admin-test-token", "owner-test-token"]) {
      const response = await send("/api/memory/profile", undefined, token);
      const text = await response.text();
      expect(text).not.toContain("4821");
      expect(text).not.toContain(invisible);
      const { facts } = JSON.parse(text) as { facts: { key: string; value: string; deleteRef: string }[] };
      expect(facts).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "[redacted]", value: "[redacted]", deleteRef: expect.stringMatching(/^~\d+$/) }),
        expect.objectContaining({ key: "left\\u{202E}right", deleteRef: `~${hidden.id}` }),
      ]));
    }
    const { facts } = await (await send("/api/memory/profile")).json() as { facts: { deleteRef: string }[] };
    for (const { deleteRef } of facts) {
      const response = await fetch(harness.baseUrl + "/api/memory/profile/" + encodeURIComponent(deleteRef), {
        method: "DELETE", headers: { authorization: "Bearer admin-test-token" },
      });
      expect(response.status).toBe(200);
    }
    expect(harness.runtime.profileStore.list()).toEqual([]);
  });

  it.each(["left\\u{202E}right", "left\u202eright", "\u200b", "\u{E0061}", "\uE000"])
    ("rejects display text copied into a memory PATCH: %s", async (text) => {
      for (const [path, body] of [
        [`/api/memory/notes/${noteId}`, { text }],
        ["/api/memory/profile/city", { value: text }],
      ] as const) {
        const response = await fetch(harness.baseUrl + path, {
          method: "PATCH", headers: { authorization: "Bearer admin-test-token", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
      }
      expect(harness.runtime.notesStore.get(noteId)?.content).toBe("Visible note");
      expect(harness.runtime.profileStore.get("city")?.value).toBe("Rome");
    });

  it.each(["family 👨‍👩‍👧", "می‌خواهم", "soft\u00adhyphen", "[redacted]", "regex \\u{1F600}"])
    ("allows literal memory edits: %s", async (text) => {
      for (const [path, body] of [
        [`/api/memory/notes/${noteId}`, { text }],
        ["/api/memory/profile/city", { value: text }],
      ] as const) {
        const response = await fetch(harness.baseUrl + path, {
          method: "PATCH", headers: { authorization: "Bearer admin-test-token", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
      }
      expect(harness.runtime.notesStore.get(noteId)?.content).toBe(text);
      expect(harness.runtime.profileStore.get("city")?.value).toBe(text);
    });

  it("logs dispatch failures without returning or logging exception text", async () => {
    const logger = vi.spyOn(harness.runtime.logger, "error");
    vi.spyOn(harness.runtime.notesStore, "list").mockImplementationOnce(() => {
      throw Object.assign(new TypeError("private detail for test"), { code: "SQLITE_BUSY", path: "/private/test-path" });
    });
    const response = await send("/api/memory/notes");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private detail");
    expect(logger).toHaveBeenCalledWith("HTTP route failed", {
      method: "GET", route: "/api/memory/notes", errorName: "TypeError", code: "SQLITE_BUSY",
    });
    expect(JSON.stringify(logger.mock.calls)).not.toContain("/private/test-path");
    expect(JSON.stringify(logger.mock.calls)).not.toContain("private detail");
  });

  it("creates a server-selected backup and returns only metadata", async () => {
    expect((await send("/api/memory/backup", { directory: "ignored" })).status).toBe(400);
    const response = await send("/api/memory/backup", {});
    expect(response.status).toBe(200);
    const backup = await response.json() as { name: string };
    expect(backup).toEqual({
      name: expect.stringMatching(/^memory-\d{8}-\d{6}-[a-f0-9-]{36}$/),
      size: expect.any(Number), date: expect.any(String),
    });
    expect(await readdir(join(harness.stateDir, "backups", backup.name))).toContain("memory.sqlite");
    expect((await send("/api/memory/restore", {})).status).toBe(404);
  });
});
