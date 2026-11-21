import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stateDirProjectRecords } from "../session/project-decisions.js";
import { readProjectRegistry } from "../session/project-registry.js";
import { projectFilePath } from "../session/project-store.js";
import { createSessionProjectStore } from "../session/session-project-store.js";
import { normalizeProject, type ProjectState } from "../session/session-project.js";
import { createEmptySessionState } from "../session/session-state.js";
import { startTestHarness, type Harness } from "./test-harness.js";

/**
 * Issue #109, part 2: the fusion projects list over HTTP, for the
 * desktop's list view: `GET /api/projects`, `POST /api/projects/forget`,
 * `POST /api/projects/resume`, and the reason on `GET /api/project`'s 404
 * when a chat's project does not open. Real runtime and session store.
 */

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "..", "session", "fixtures", "session-with-embedded-project-109.json"), "utf8")) as {
  session: { project: unknown };
};

describe("/api/projects", () => {
  let harness: Harness;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aa-http-projects-"));
  });

  afterEach(async () => {
    await harness?.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  function folderWithProject(name: string): string {
    const folder = join(root, name);
    mkdirSync(folder);
    const projects = createSessionProjectStore({ stateDir: harness.stateDir, records: stateDirProjectRecords(harness.stateDir) });
    const r = projects.commit(createEmptySessionState({ id: `seed-${name}`, workingDir: folder }), normalizeProject(fixture.session.project) as ProjectState);
    if (!r.ok) throw new Error(r.problem.message);
    return folder;
  }

  const post = async (path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${harness.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it("lists healthy, damaged and missing folders, resumes one, forgets one", async () => {
    harness = await startTestHarness();
    const game = folderWithProject("game");
    expect(JSON.parse(readFileSync(projectFilePath(game), "utf8"))).toMatchObject({ schemaVersion: 2 });
    const gone = folderWithProject("gone");
    const broken = folderWithProject("broken");
    rmSync(gone, { recursive: true, force: true });
    writeFileSync(projectFilePath(broken), "{");

    const res = await fetch(`${harness.baseUrl}/api/projects`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as { schema: number; projects: Array<Record<string, unknown>>; registry_problem: string | null };
    expect(list.schema).toBe(1);
    expect(list.registry_problem).toBeNull();
    expect(list.projects.map((row) => [row.folder, row.status, row.zone])).toEqual([
      [game, "ok", "needs-you"],
      [gone, "missing", "problem"],
      [broken, "damaged", "problem"],
    ]);
    expect(list.projects[0]).toMatchObject({ name: "game", gate: "milestone m2", next: "you review milestone m2" });

    const resumed = await post("/api/projects/resume", { folder: game });
    expect(resumed.status).toBe(200);
    expect(resumed.json).toMatchObject({ schema: 1, folder: game, name: "game", created: true });
    const sid = resumed.json.session_id as string;
    expect((resumed.json.view as { gate: unknown }).gate).toEqual({ kind: "milestone", id: "m2" });
    expect(harness.runtime.sessionStore.load(sid)?.workingDir).toBe(game);
    // The chat opens like any other: its view through the existing route, unchanged.
    const opened = (await (await fetch(`${harness.baseUrl}/api/project?session=${sid}`)).json()) as { session_id: string; view: { gate: unknown } };
    expect(opened.session_id).toBe(sid);
    expect(opened.view.gate).toEqual({ kind: "milestone", id: "m2" });
    expect((await post("/api/projects/resume", { folder: game })).json).toMatchObject({ session_id: sid, created: false });

    const refused = await post("/api/projects/resume", { folder: broken });
    expect(refused.status).toBe(422);
    expect(refused.json).toMatchObject({ error: { code: "project-unavailable" } });
    expect((await post("/api/projects/resume", { folder: join(root, "elsewhere") })).status).toBe(404);
    expect((await post("/api/projects/resume", { folder: "game" })).status).toBe(400);

    // The chat's project breaks: GET /api/project is still 404, now with the reason.
    writeFileSync(projectFilePath(game), "{");
    const broke = await fetch(`${harness.baseUrl}/api/project?session=${sid}`);
    expect(broke.status).toBe(404);
    const body = (await broke.json()) as { error: { message: string }; project_problem?: string };
    expect(body.error.message).toBe(`no project on session ${sid}`);
    expect(body.project_problem).toMatch(/project/i);
    // A chat with no project at all says no problem.
    const none = (await (await fetch(`${harness.baseUrl}/api/project?session=nope`)).json()) as Record<string, unknown>;
    expect(none.project_problem).toBeUndefined();

    const forgot = await post("/api/projects/forget", { folder: gone });
    expect(forgot).toEqual({ status: 200, json: { schema: 1, folder: gone, forgotten: true } });
    expect((await post("/api/projects/forget", { folder: gone })).json).toEqual({ schema: 1, folder: gone, forgotten: false });
    expect((await post("/api/projects/forget", { folder: 7 })).status).toBe(400);
    expect(readProjectRegistry(harness.stateDir)).toEqual({ ok: true, folders: [game, broken] });
  });

  it("withholds restricted projects and chats from network clients", async () => {
    const restricted = join(root, "restricted");
    harness = await startTestHarness({
      host: "0.0.0.0",
      constraints: { [restricted]: { allowedProviders: ["local-llama"] } },
    });
    folderWithProject("restricted");
    const game = folderWithProject("game");
    const resumed = await post("/api/projects/resume", { folder: game });
    expect(resumed.status).toBe(200);
    const session = harness.runtime.sessionStore.load(resumed.json.session_id as string)!;
    harness.runtime.sessionStore.save({
      ...session,
      metadata: {
        ...session.metadata,
        providerReadTaint: {
          key: restricted, matchedDir: restricted, readFrom: [restricted],
          allowedProviders: ["local-llama"], allowedEgress: [],
        },
      },
    });

    const res = await fetch(`${harness.baseUrl}/api/projects`);
    expect(await res.json()).toMatchObject({ projects: [{ folder: game }] });
    for (const [path, folder] of [
      ["/api/projects/resume", restricted],
      ["/api/projects/forget", restricted],
      ["/api/projects/resume", game],
    ] as const) {
      expect(await post(path, { folder })).toMatchObject({
        status: 403,
        json: { error: { code: "folder_restricted" } },
      });
    }
    expect(readProjectRegistry(harness.stateDir)).toEqual({ ok: true, folders: [restricted, game] });
  });
});
