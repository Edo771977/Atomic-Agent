import { randomUUID } from "node:crypto";
import { Database } from "../native/load-better-sqlite3.js";
import type { IdeaCandidate } from "./idea-types.js";

/** Insert a card from before sync validated its source, for cleanup tests. */
export function seedLegacyRetry(dbFile: string, candidate: IdeaCandidate): string {
  const db = new Database(dbFile);
  const id = randomUUID();
  try {
    db.prepare(`INSERT INTO ideas
      (id, kind, source_key, title, reason, evidence_json, prompt, session_id, source_session_id, status, created_at, updated_at)
      VALUES (?, 'retry_task', ?, ?, ?, ?, ?, ?, ?, 'new', 1, 1)`).run(
      id, candidate.sourceKey, candidate.title, candidate.reason, JSON.stringify(candidate.evidence),
      candidate.prompt, candidate.sessionId, candidate.sourceSessionId ?? candidate.sessionId,
    );
    return id;
  } finally {
    db.close();
  }
}
