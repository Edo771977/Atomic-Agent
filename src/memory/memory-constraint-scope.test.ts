import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeProviderPolicy, runWithProviderPolicy, type ProviderPolicy } from "../llm/provider-policy.js";
import { MemoryStore } from "./memory-store.js";
import { ProfileStore, ProfileValidationError } from "./profile-store.js";
import { LessonStore } from "./lessons/lesson-store.js";
import { ProcedureStore } from "./procedures/procedure-store.js";
import {
  backfillConstraintScopes,
  constraintScopeOf,
  createConstraintScopeBackfill,
  readConstraintScopeBackfillRecord,
  listConstraintScopes,
  policyForConstraintScope,
  runInMemoryRowScope,
  scopeVisibleTo,
} from "./memory-constraint-scope.js";

const secret = makeProviderPolicy({ key: "/work/secret", allowedProviders: ["local-llama"], matchedDir: "/work/secret" });
const other = makeProviderPolicy({ key: "/work/other", allowedProviders: ["openai"], matchedDir: "/work/other" });
const stricter = makeProviderPolicy({ key: "/work/stricter", allowedProviders: ["local-llama"], matchedDir: "/work/stricter" });

function under<T>(policy: ProviderPolicy | undefined, fn: () => T): T {
  return runWithProviderPolicy(policy, fn);
}

describe("memory constraint scope", () => {
  let tmp: string;
  let dbFile: string;
  let notes: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-scope-"));
    dbFile = join(tmp, "memory.sqlite");
    notes = new MemoryStore({ dbFile, maxEntries: 1000 });
  });

  afterEach(() => {
    notes.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("visibility rule: same key, or a policy whose allowed list is a subset", () => {
    const row = constraintScopeOf(secret);
    expect(scopeVisibleTo(null, undefined)).toBe(true);
    expect(scopeVisibleTo(row, undefined)).toBe(false);
    expect(scopeVisibleTo(row, secret)).toBe(true);
    expect(scopeVisibleTo(row, other)).toBe(false);
    expect(scopeVisibleTo(row, stricter)).toBe(true);
    expect(scopeVisibleTo("not json", secret)).toBe(false);
  });

  it("visibility also requires the reader's egress to be a subset of the row's (M1)", () => {
    const noEgress = makeProviderPolicy({ key: "/work/a", allowedProviders: ["local-llama"], matchedDir: "/work/a" });
    const leaky = makeProviderPolicy({ key: "/work/b", allowedProviders: ["local-llama"], allowedEgress: ["web", "channels"], matchedDir: "/work/b" });
    const webOnly = makeProviderPolicy({ key: "/work/c", allowedProviders: ["local-llama"], allowedEgress: ["web"], matchedDir: "/work/c" });
    expect(scopeVisibleTo(constraintScopeOf(noEgress), leaky)).toBe(false);
    expect(scopeVisibleTo(constraintScopeOf(leaky), webOnly)).toBe(true);
    expect(scopeVisibleTo(constraintScopeOf(leaky), noEgress)).toBe(true);
    expect(scopeVisibleTo(constraintScopeOf(webOnly), leaky)).toBe(false);
    // A descriptor written before allowedEgress existed reads as none (strictest).
    const legacy = JSON.stringify({ key: "/work/a", allowedProviders: ["local-llama"] });
    expect(scopeVisibleTo(legacy, leaky)).toBe(false);
    expect(scopeVisibleTo(legacy, noEgress)).toBe(true);
    expect(policyForConstraintScope(constraintScopeOf(leaky)).allowedEgress).toEqual(["channels", "web"]);
    expect(policyForConstraintScope(legacy).allowedEgress).toEqual([]);

    const stored = under(noEgress, () => notes.store({ content: "folder a secret walrus" }));
    expect(under(leaky, () => notes.get(stored.id))).toBeNull();
    expect(under(leaky, () => notes.recall("walrus", { k: 5 }))).toEqual([]);
    expect(under(noEgress, () => notes.get(stored.id))?.content).toBe("folder a secret walrus");
  });

  it("visibility also requires the reader's other-machine hosts to be a subset of the row's (issue #60)", () => {
    const here = makeProviderPolicy({ key: "/work/a", allowedProviders: ["local-llama"], matchedDir: "/work/a" });
    const lan = makeProviderPolicy({ key: "/work/b", allowedProviders: ["local-llama"], allowedProviderHosts: ["gpu-box.lan"], matchedDir: "/work/b" });
    expect(scopeVisibleTo(constraintScopeOf(here), lan)).toBe(false);
    expect(scopeVisibleTo(constraintScopeOf(lan), here)).toBe(true);
    // No hosts: the descriptor is the one written before issue #60.
    expect(constraintScopeOf(here)).toBe(JSON.stringify({ key: "/work/a", allowedProviders: ["local-llama"], allowedEgress: [] }));
    expect(policyForConstraintScope(constraintScopeOf(lan)).allowedProviderHosts).toEqual(["gpu-box.lan"]);
  });

  it("migrates a legacy descriptor in place to carry an empty allowedEgress", () => {
    under(secret, () => notes.store({ content: "legacy scoped note" }));
    const db = notes.getDatabaseHandleForEmbeddings() as unknown as { prepare(sql: string): { run(...p: unknown[]): unknown; all(): unknown[] } };
    const legacy = JSON.stringify({ key: secret.key, allowedProviders: ["local-llama"] });
    db.prepare("UPDATE memories SET constraint_scope = ?").run(legacy);
    notes.close();
    notes = new MemoryStore({ dbFile, maxEntries: 1000 });
    expect(listConstraintScopes(notes.getDatabaseHandleForEmbeddings())).toEqual([constraintScopeOf(secret)]);
    expect(constraintScopeOf(secret)).toContain('"allowedEgress":[]');
  });

  it("a note stored in a constrained folder is recalled only in a session it is visible to", () => {
    const stored = under(secret, () => notes.store({ content: "the merger codename is bluebird" }));
    under(undefined, () => notes.store({ content: "bluebird is also a song" }));

    const recallIn = (policy: ProviderPolicy | undefined): string[] =>
      under(policy, () => notes.recall("bluebird", { k: 5 }).map((e) => e.content).sort());

    expect(recallIn(undefined)).toEqual(["bluebird is also a song"]);
    expect(recallIn(other)).toEqual(["bluebird is also a song"]);
    expect(recallIn(secret)).toEqual(["bluebird is also a song", "the merger codename is bluebird"]);
    // No frame at all (a CLI, an unscoped job) sees only untagged rows.
    expect(notes.recall("bluebird", { k: 5 }).map((e) => e.content)).toEqual(["bluebird is also a song"]);

    expect(under(undefined, () => notes.get(stored.id))).toBeNull();
    expect(under(secret, () => notes.get(stored.id))?.content).toBe("the merger codename is bluebird");
    expect(under(undefined, () => notes.list().map((e) => e.id))).not.toContain(stored.id);
    expect(under(undefined, () => notes.listIndex().map((e) => e.id))).not.toContain(stored.id);
    expect(under(secret, () => notes.list().map((e) => e.id))).toContain(stored.id);
  });

  it("dedup never merges a write into a row of another scope", () => {
    const n = new MemoryStore({ dbFile: join(tmp, "dedup.sqlite"), maxEntries: 100, dedup: { enabled: true, fts5Threshold: 0.5 } });
    try {
      const a = under(secret, () => n.store({ content: "deploy with the blue script" }));
      const b = under(undefined, () => n.store({ content: "deploy with the blue script" }));
      expect(b.id).not.toBe(a.id);
      expect(under(undefined, () => n.recall("blue", { k: 5 }).map((e) => e.id))).toEqual([b.id]);
    } finally {
      n.close();
    }
  });

  it("the row scope of a background pass sees exactly that scope and writes it", () => {
    under(secret, () => notes.store({ content: "secret alpha note" }));
    under(undefined, () => notes.store({ content: "public alpha note" }));
    const scopes = listConstraintScopes(notes.getDatabaseHandleForEmbeddings());
    expect(scopes).toEqual([constraintScopeOf(secret)]);

    const inScope = runInMemoryRowScope(scopes[0]!, () => notes.recall("alpha", { k: 5 }).map((e) => e.content));
    expect(inScope).toEqual(["secret alpha note"]);
    const unscoped = runInMemoryRowScope(null, () => notes.recall("alpha", { k: 5 }).map((e) => e.content));
    expect(unscoped).toEqual(["public alpha note"]);

    const written = runInMemoryRowScope(scopes[0]!, () => notes.store({ content: "secret beta note" }));
    expect(under(undefined, () => notes.get(written.id))).toBeNull();
    expect(under(secret, () => notes.get(written.id))?.content).toBe("secret beta note");
  });

  it("lessons and procedures carry the scope of the frame that wrote them", () => {
    const lessons = new LessonStore({ dbFile, maxEntries: 100 });
    const procedures = new ProcedureStore({ dbFile, maxEntries: 100 });
    try {
      const lesson = under(secret, () => lessons.create({ activation: "when deploying bluebird", principle: "use the blue script", parentIds: [1, 2] }));
      expect(under(undefined, () => lessons.getById(lesson.id))).toBeNull();
      expect(under(undefined, () => lessons.listIndex({ limit: 10 }).map((l) => l.id))).not.toContain(lesson.id);
      expect(under(undefined, () => lessons.recall({ query: "bluebird" }).map((l) => l.id))).not.toContain(lesson.id);
      expect(under(secret, () => lessons.recall({ query: "bluebird" }).map((l) => l.id))).toContain(lesson.id);

      const proc = under(secret, () => procedures.create({ activation: "when deploying bluebird", steps: [{ description: "run blue", toolHint: null }, { description: "check blue", toolHint: null }], parentLessonIds: [lesson.id], parentMemoryIds: [1] }));
      expect(under(undefined, () => procedures.getById(proc.id))).toBeNull();
      expect(under(other, () => procedures.recall({ query: "bluebird" }).map((p) => p.id))).not.toContain(proc.id);
      expect(under(secret, () => procedures.recall({ query: "bluebird" }).map((p) => p.id))).toContain(proc.id);
    } finally {
      lessons.close();
      procedures.close();
    }
  });

  it("profile facts are scoped, and a write never supersedes a fact of another scope", () => {
    const profile = new ProfileStore({ dbFile });
    try {
      under(secret, () => profile.set("client", "Bluebird Corp"));
      expect(under(undefined, () => profile.get("client"))).toBeNull();
      expect(under(undefined, () => profile.list().map((f) => f.key))).not.toContain("client");
      expect(under(secret, () => profile.get("client"))?.value).toBe("Bluebird Corp");
      expect(() => under(undefined, () => profile.set("client", "Someone else"))).toThrow(ProfileValidationError);
      expect(under(undefined, () => profile.remove("client"))).toBe(false);
      expect(under(secret, () => profile.get("client"))?.value).toBe("Bluebird Corp");

      under(undefined, () => profile.set("editor", "vim"));
      expect(() => under(secret, () => profile.set("editor", "emacs"))).toThrow(ProfileValidationError);
      expect(under(secret, () => profile.get("editor"))?.value).toBe("vim");
      expect(under(undefined, () => profile.get("editor"))?.value).toBe("vim");
    } finally {
      profile.close();
    }
  });

  describe("back-fill of rows written before a constraint existed (M2)", () => {
    const resolveFor = (dir: string): ProviderPolicy | undefined =>
      dir === "/work/secret" || dir.startsWith("/work/secret/") ? secret : undefined;

    it("tags untagged notes, lessons and procedures under a constrained folder, idempotently", () => {
      const lessons = new LessonStore({ dbFile, maxEntries: 100 });
      const procedures = new ProcedureStore({ dbFile, maxEntries: 100 });
      const profile = new ProfileStore({ dbFile });
      try {
        const old = notes.store({ content: "old walrus secret", workingDir: "/work/secret/app" });
        const open = notes.store({ content: "open walrus note", workingDir: "/work/open" });
        const lesson = lessons.create({ activation: "when walrus", principle: "use walrus", parentIds: [1, 2], workingDir: "/work/secret" });
        const proc = procedures.create({ activation: "when walrus", steps: [{ description: "a", toolHint: null }, { description: "b", toolHint: null }], parentLessonIds: [lesson.id], parentMemoryIds: [1], workingDir: "/work/secret" });
        profile.set("editor", "vim");
        // Visible everywhere before the back-fill.
        expect(notes.get(old.id)?.content).toBe("old walrus secret");

        const db = notes.getDatabaseHandleForEmbeddings();
        const first = backfillConstraintScopes(db, resolveFor);
        expect(first.tagged).toEqual({ memories: 1, lessons: 1, procedures: 1 });
        expect(first.untaggedProfileFacts).toBe(1);
        expect(backfillConstraintScopes(db, resolveFor).tagged).toEqual({ memories: 0, lessons: 0, procedures: 0 });

        expect(notes.get(old.id)).toBeNull();
        expect(under(secret, () => notes.get(old.id))?.content).toBe("old walrus secret");
        expect(notes.get(open.id)?.content).toBe("open walrus note");
        expect(lessons.getById(lesson.id)).toBeNull();
        expect(procedures.getById(proc.id)).toBeNull();
        // The consolidator's untagged pass no longer sees it.
        expect(runInMemoryRowScope(null, () => notes.recall("walrus", { k: 5 }).map((e) => e.content))).toEqual(["open walrus note"]);
      } finally {
        lessons.close();
        procedures.close();
        profile.close();
      }
    });

    it("runs again only when the constraints change, and records what it did for doctor", () => {
      notes.store({ content: "later walrus", workingDir: "/work/later" });
      let constraints: Record<string, unknown> = {};
      let resolve: (dir: string) => ProviderPolicy | undefined = () => undefined;
      const db = notes.getDatabaseHandleForEmbeddings();
      const backfill = createConstraintScopeBackfill({ db, readConstraints: () => constraints, resolvePolicy: (dir) => resolve(dir) });
      expect(backfill.ensure()?.tagged.memories).toBe(0);
      expect(backfill.ensure()).toBeNull();
      constraints = { "/work/later": { allowedProviders: ["local-llama"] } };
      resolve = (dir) => (dir === "/work/later" ? secret : undefined);
      expect(backfill.ensure()?.tagged.memories).toBe(1);
      expect(readConstraintScopeBackfillRecord(db)).toMatchObject({ retroTagged: 1 });
      expect(notes.recall("walrus", { k: 5 })).toEqual([]);
    });
  });
});
