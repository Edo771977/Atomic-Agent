import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptySessionState } from "../session/index.js";

import { checkWorkingDir } from "./session-working-dir.js";
import { startTestHarness, type Harness } from "./test-harness.js";

describe("checkWorkingDir (ATO-731)", () => {
  it("takes an existing absolute folder and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-"));
    expect(checkWorkingDir(dir)).toEqual({ ok: true, dir });
    expect(checkWorkingDir("relative/path").ok).toBe(false);
    expect(checkWorkingDir(join(dir, "missing")).ok).toBe(false);
    expect(checkWorkingDir("").ok).toBe(false);
    expect(checkWorkingDir(42).ok).toBe(false);
  });
});

describe("POST /api/sessions/{id}/working-dir (ATO-731)", () => {
  let harness: Harness;
  beforeEach(async () => { harness = await startTestHarness(); });
  afterEach(async () => { vi.restoreAllMocks(); await harness.cleanup(); });

  const post = (id: string, workingDir: unknown) => fetch(`${harness.baseUrl}/api/sessions/${id}/working-dir`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workingDir }),
  });

  it("moves one chat to another folder, and lists it with scope=all", async () => {
    harness.runtime.sessionStore.save(createEmptySessionState({ id: "wd-1", workingDir: harness.workingDir }));
    const other = mkdtempSync(join(tmpdir(), "wd-other-"));
    const res = await post("wd-1", other);
    expect(res.status).toBe(200);
    expect(harness.runtime.sessionStore.load("wd-1")?.workingDir).toBe(other);
    const here = (await (await fetch(`${harness.baseUrl}/api/sessions`)).json()) as { sessions: Array<{ id: string }> };
    expect(here.sessions.map((s) => s.id)).not.toContain("wd-1");
    const all = (await (await fetch(`${harness.baseUrl}/api/sessions?scope=all`)).json()) as { sessions: Array<{ id: string }> };
    expect(all.sessions.map((s) => s.id)).toContain("wd-1");
  });

  it("refuses while that chat runs a turn, an unknown chat, and a bad folder", async () => {
    harness.runtime.sessionStore.save(createEmptySessionState({ id: "wd-2", workingDir: harness.workingDir }));
    vi.spyOn(harness.runtime.turnController, "isBusy").mockImplementation((id: string) => id === "wd-2");
    expect((await post("wd-2", harness.workingDir)).status).toBe(409);
    expect((await post("nope", harness.workingDir)).status).toBe(404);
    expect((await post("wd-2", "relative")).status).toBe(400);
  });

  it("refuses a chat another process runs a turn in", async () => {
    // The store reports `running` from another process's live turn; a plain save of the field is normalised away.
    const state = { ...createEmptySessionState({ id: "wd-3", workingDir: harness.workingDir }), status: "running" as const };
    harness.runtime.sessionStore.save(state);
    vi.spyOn(harness.runtime.sessionStore, "load").mockReturnValue(state);
    expect((await post("wd-3", harness.workingDir)).status).toBe(409);
  });
});

/**
 * Issue #68: moving a chat out of (or between) constrained folders never
 * widens what it may reach. The old effective policy rides with the chat
 * as its read taint, so the new folder's constraint is intersected with it.
 */
describe("POST /api/sessions/{id}/working-dir keeps a folder's restriction (issue #68)", () => {
  let harness: Harness | undefined;
  afterEach(async () => { await harness?.cleanup(); harness = undefined; });

  const post = (h: Harness, id: string, workingDir: string) => fetch(`${h.baseUrl}/api/sessions/${id}/working-dir`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workingDir }),
  });
  const restrictionOf = async (h: Harness, id: string) =>
    ((await (await fetch(`${h.baseUrl}/api/sessions/${id}/provider-restriction`)).json()) as { restriction: { allowedProviders: string[]; readFrom: string[]; movedFrom: string[] } | null }).restriction;

  it("a restricted chat moved to an unconstrained folder still refuses a cloud provider and web egress", async () => {
    harness = await startTestHarness({ constraints: { "<cwd>": { allowedProviders: ["local-llama"] } } });
    const open = mkdtempSync(join(tmpdir(), "wd-open-"));
    harness.runtime.sessionStore.save(createEmptySessionState({ id: "wd-r1", workingDir: harness.workingDir }));
    const res = await post(harness, "wd-r1", open);
    expect(res.status).toBe(200);
    const moved = harness.runtime.sessionStore.load("wd-r1")!;
    expect(moved.workingDir).toBe(open);
    // The next turn's policy: no cloud provider, no web.
    expect(harness.runtime.egressRefusal?.("wd-r1", "web")).toContain("restricted");
    expect(harness.runtime.providerRestrictionFor?.(moved)?.allowedProviders).toEqual(["local-llama"]);
    expect(await restrictionOf(harness, "wd-r1")).toMatchObject({ allowedProviders: ["local-llama"], readFrom: [], movedFrom: [harness.workingDir] });
    const body = (await res.json()) as { workingDir: string; restrictionKept: boolean; restriction: { allowedProviders: string[] } | null };
    expect(body.workingDir).toBe(open);
    expect(body.restrictionKept).toBe(true);
    expect(body.restriction?.allowedProviders).toEqual(["local-llama"]);
  });

  it("an unrestricted chat moved anywhere changes nothing", async () => {
    harness = await startTestHarness({ constraints: { "<cwd>": { allowedProviders: ["local-llama"] } } });
    const a = mkdtempSync(join(tmpdir(), "wd-a-"));
    const b = mkdtempSync(join(tmpdir(), "wd-b-"));
    harness.runtime.sessionStore.save(createEmptySessionState({ id: "wd-u1", workingDir: a }));
    const res = await post(harness, "wd-u1", b);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "wd-u1", workingDir: b, restriction: null, restrictionKept: false });
    const moved = harness.runtime.sessionStore.load("wd-u1")!;
    expect(moved.metadata?.providerReadTaint).toBeUndefined();
    expect(harness.runtime.egressRefusal?.("wd-u1", "web")).toBeNull();
    // Into a constrained folder: that folder's own constraint, nothing carried.
    const into = await post(harness, "wd-u1", harness.workingDir);
    expect(((await into.json()) as { restrictionKept: boolean }).restrictionKept).toBe(false);
    expect(harness.runtime.sessionStore.load("wd-u1")?.metadata?.providerReadTaint).toBeUndefined();
  });

  it("moving between constrained folders intersects their constraints", async () => {
    const other = mkdtempSync(join(tmpdir(), "wd-c-"));
    harness = await startTestHarness({
      constraints: {
        "<cwd>": { allowedProviders: ["local-llama", "openai"], allowedEgress: ["web", "http"] },
        [other]: { allowedProviders: ["local-llama", "anthropic"], allowedEgress: ["web", "git"] },
      },
    });
    harness.runtime.sessionStore.save(createEmptySessionState({ id: "wd-i1", workingDir: harness.workingDir }));
    const res = await post(harness, "wd-i1", other);
    expect(res.status).toBe(200);
    expect(harness.runtime.egressRefusal?.("wd-i1", "web")).toBeNull();
    expect(harness.runtime.egressRefusal?.("wd-i1", "http")).toContain("restricted");
    expect(harness.runtime.egressRefusal?.("wd-i1", "git")).toContain("restricted");
    expect(await restrictionOf(harness, "wd-i1")).toMatchObject({ allowedProviders: ["local-llama"] });
    expect(((await res.json()) as { restriction: { allowedProviders: string[] } }).restriction.allowedProviders).toEqual(["local-llama"]);
  });

  it("the carried restriction persists in the stored chat (reload, /resume) and through a second move", async () => {
    harness = await startTestHarness({ constraints: { "<cwd>": { allowedProviders: ["local-llama"] } } });
    const first = mkdtempSync(join(tmpdir(), "wd-p1-"));
    const second = mkdtempSync(join(tmpdir(), "wd-p2-"));
    harness.runtime.sessionStore.save(createEmptySessionState({ id: "wd-p", workingDir: harness.workingDir }));
    expect((await post(harness, "wd-p", first)).status).toBe(200);
    expect((await post(harness, "wd-p", second)).status).toBe(200);
    const reloaded = harness.runtime.sessionStore.load("wd-p")!;
    expect(reloaded.workingDir).toBe(second);
    expect(reloaded.metadata?.providerReadTaint).toMatchObject({ key: harness.workingDir, allowedProviders: ["local-llama"], allowedEgress: [] });
    expect(harness.runtime.egressRefusal?.("wd-p", "web")).toContain("restricted");
    expect(await restrictionOf(harness, "wd-p")).toMatchObject({ allowedProviders: ["local-llama"] });
  });
});
