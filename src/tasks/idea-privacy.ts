import type Database from "better-sqlite3";

interface StoredIdea {
  id: string;
  kind: string;
  source_key: string;
  evidence_json: string;
  session_id: string | null;
  source_session_id?: string | null;
}

function storedIdeas(db: Database.Database): StoredIdea[] {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'ideas'").get()) return [];
  return db.prepare("SELECT * FROM ideas").all() as StoredIdea[];
}

function sourceTaskId(idea: StoredIdea): string | null {
  if (idea.kind !== "retry_task") return null;
  try {
    const evidence = JSON.parse(idea.evidence_json) as { source?: unknown; ref?: unknown };
    if (evidence.source === "task" && typeof evidence.ref === "string") return evidence.ref;
  } catch { /* Older cards can still identify their source by key. */ }
  return idea.source_key.startsWith("task:") ? idea.source_key.slice(5) : null;
}

/** Called inside the task deletion transaction, before its source rows disappear. */
export function removeSessionIdeas(db: Database.Database, sessionId: string): void {
  const ideas = storedIdeas(db);
  if (!ideas.length) return;
  const taskIds = new Set((db.prepare("SELECT id FROM tasks WHERE session_id = ?").all(sessionId) as { id: string }[]).map((t) => t.id));
  const remove = db.prepare("DELETE FROM ideas WHERE id = ?");
  for (const idea of ideas) {
    if (idea.source_session_id === sessionId || idea.session_id === sessionId || taskIds.has(sourceTaskId(idea) ?? "")) remove.run(idea.id);
  }
}

/** Legacy cards without an extant task survive only when their source is provably ordinary. */
export function removeUnsafeRetryIdeas(db: Database.Database, sessionPrivacy: (id: string) => boolean | null): number {
  const ideas = storedIdeas(db);
  if (!ideas.length) return 0;
  const columns = db.prepare("PRAGMA table_info(ideas)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "source_session_id")) db.exec("ALTER TABLE ideas ADD COLUMN source_session_id TEXT");
  const task = db.prepare("SELECT session_id, incognito FROM tasks WHERE id = ?");
  const remove = db.prepare("DELETE FROM ideas WHERE id = ?");
  const record = db.prepare("UPDATE ideas SET source_session_id = COALESCE(source_session_id, ?) WHERE id = ?");
  let removed = 0;
  for (const idea of ideas) {
    if (idea.kind !== "retry_task") continue;
    const source = task.get(sourceTaskId(idea) ?? "") as { session_id: string | null; incognito: number } | undefined;
    const origin = source?.session_id ?? idea.source_session_id ?? idea.session_id;
    const privateSession = origin == null ? null : sessionPrivacy(origin);
    if (source?.incognito === 1 || privateSession === true || (!source && privateSession !== false)) {
      removed += remove.run(idea.id).changes;
    } else if (origin != null) record.run(origin, idea.id);
  }
  return removed;
}
