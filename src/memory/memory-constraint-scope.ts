import { AsyncLocalStorage } from "node:async_hooks";
import {
  currentProviderPolicy,
  makeProviderPolicy,
  runWithProviderPolicy,
  type ProviderPolicy,
} from "../llm/provider-policy.js";

/**
 * Memory scoping for per-folder provider constraints (issue #33 §5,
 * group C). See ../llm/docs/provider-policy.md#memory-scoping.
 *
 * Every row written while a constraint governs the call (notes, lessons,
 * procedures, profile facts) carries that constraint in its own
 * `constraint_scope` column: a JSON descriptor
 * `{"key", "allowedProviders", "allowedEgress"}` (plus
 * `"allowedProviderHosts"` when the policy lists any, issue #60) frozen at write time (a
 * descriptor written before `allowedEgress` existed reads as none, the
 * strictest, and is rewritten in place on open). It is not a tag, so the notes tool, reflection
 * EVOLVE and the reconciler can neither add nor strip it. Untagged rows
 * (`NULL`) are what every session sees.
 *
 * A tagged row is visible to a call whose policy has the same key, or a
 * policy whose allowed providers, allowed egress classes AND other-machine
 * hosts are all subsets of the row's (a stricter one: the row's content could only
 * reach providers and leave through tools its own folder already
 * allowed). An unconstrained call, or one with no frame at all (a CLI,
 * an unscoped job), sees untagged rows only.
 *
 * The stores read the scope of the call running now through two SQLite
 * functions registered on every memory connection:
 * `memory_scope_visible(constraint_scope)` in each read, and
 * `memory_scope_write()` in each insert. Both read the provider-policy
 * frame (`currentProviderPolicy`) or, inside a background pass, the row
 * scope set by `runInMemoryRowScope`.
 */

interface ScopeDescriptor {
  key: string;
  allowedProviders: string[];
  /** Absent in a descriptor from before egress scoping: none. */
  allowedEgress: string[];
  /** Other machines a local provider may be reached at (issue #60); absent: none. */
  allowedProviderHosts: string[];
}

/** The `constraint_scope` value of rows written under `policy`. */
export function constraintScopeOf(
  policy: Pick<ProviderPolicy, "key" | "allowedProviders"> & {
    allowedEgress?: readonly string[];
    allowedProviderHosts?: readonly string[];
  },
): string {
  const allowedProviders = [...new Set(policy.allowedProviders)].sort();
  const allowedEgress = [...new Set(policy.allowedEgress ?? [])].sort();
  const allowedProviderHosts = [...new Set(policy.allowedProviderHosts ?? [])].sort();
  // Written only when non-empty, so every descriptor from before issue #60 stays byte-identical.
  return JSON.stringify(allowedProviderHosts.length === 0
    ? { key: policy.key, allowedProviders, allowedEgress }
    : { key: policy.key, allowedProviders, allowedEgress, allowedProviderHosts });
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

const parsed = new Map<string, ScopeDescriptor | null>();

/** Parse a stored scope; anything malformed is `undefined` (visible to nobody). */
export function parseConstraintScope(scope: string): ScopeDescriptor | undefined {
  const cached = parsed.get(scope);
  if (cached !== undefined) return cached ?? undefined;
  let value: ScopeDescriptor | null = null;
  try {
    const raw: unknown = JSON.parse(scope);
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const { key, allowedProviders, allowedEgress, allowedProviderHosts } = raw as Record<string, unknown>;
      if (
        typeof key === "string" &&
        isStringArray(allowedProviders) &&
        (allowedEgress === undefined || isStringArray(allowedEgress)) &&
        (allowedProviderHosts === undefined || isStringArray(allowedProviderHosts))
      ) {
        value = { key, allowedProviders, allowedEgress: allowedEgress ?? [], allowedProviderHosts: allowedProviderHosts ?? [] };
      }
    }
  } catch {
    value = null;
  }
  if (parsed.size > 256) parsed.clear();
  parsed.set(scope, value);
  return value ?? undefined;
}

/**
 * The policy a background pass over rows of `scope` runs under: the
 * row's own key, allowed list and egress classes. A malformed scope
 * allows nothing.
 */
export function policyForConstraintScope(scope: string): ProviderPolicy {
  const d = parseConstraintScope(scope);
  return d === undefined
    ? makeProviderPolicy({ key: "(unreadable memory scope)", allowedProviders: [], matchedDir: "" })
    : makeProviderPolicy({
      key: d.key,
      allowedProviders: d.allowedProviders,
      allowedEgress: d.allowedEgress,
      allowedProviderHosts: d.allowedProviderHosts,
      matchedDir: d.key,
    });
}

/** Whether a row of `rowScope` may be read by a call under `policy`. */
export function scopeVisibleTo(rowScope: string | null, policy: ProviderPolicy | undefined): boolean {
  if (rowScope === null) return true;
  if (policy === undefined) return false;
  const row = parseConstraintScope(rowScope);
  if (row === undefined) return false;
  if (row.key === policy.key) return true;
  return policy.allowedProviders.every((id) => row.allowedProviders.includes(id))
    && policy.allowedEgress.every((cls) => row.allowedEgress.includes(cls))
    && policy.allowedProviderHosts.every((host) => row.allowedProviderHosts.includes(host));
}

const rowScopeStore = new AsyncLocalStorage<{ scope: string | null }>();

/**
 * Run a background pass over the rows of exactly one scope (`null`:
 * untagged rows). Reads see only that scope, writes carry it, and every
 * provider call inside runs under the row's policy (`undefined` for
 * untagged rows), so a disallowed provider is refused at dispatch.
 */
export function runInMemoryRowScope<T>(scope: string | null, fn: () => T): T {
  const policy = scope === null ? undefined : policyForConstraintScope(scope);
  return rowScopeStore.run({ scope }, () =>
    runWithProviderPolicy(policy, fn, { role: "memory maintenance" }),
  );
}

/** The scope a row written now carries. */
export function currentWriteScope(): string | null {
  const pass = rowScopeStore.getStore();
  if (pass !== undefined) return pass.scope;
  const policy = currentProviderPolicy();
  return policy === undefined ? null : constraintScopeOf(policy);
}

/** Whether a row of `rowScope` is visible to the call running now. */
export function currentScopeVisible(rowScope: string | null): boolean {
  const pass = rowScopeStore.getStore();
  if (pass !== undefined) return rowScope === pass.scope;
  return scopeVisibleTo(rowScope, currentProviderPolicy());
}

export const CONSTRAINT_SCOPE_TABLES = ["memories", "lessons", "procedures", "profile_facts"] as const;

interface ScopeDb {
  exec(sql: string): unknown;
  prepare(sql: string): { get(...params: unknown[]): unknown; all?(...params: unknown[]): unknown[]; run?(...params: unknown[]): unknown };
  function?: (name: string, options: { deterministic?: boolean }, fn: (...args: never[]) => unknown) => unknown;
}

/**
 * Add the `constraint_scope` column (in place, no schema version bump:
 * the name-grounding precedent, so an older binary still opens the
 * file; a row it writes is untagged) and register the scope functions
 * on this connection. Idempotent; called from `applyMigrations`.
 */
export function ensureConstraintScopeSchema(db: ScopeDb): void {
  for (const table of CONSTRAINT_SCOPE_TABLES) {
    const present = db
      .prepare(`SELECT 1 AS present FROM pragma_table_info('${table}') WHERE name = 'constraint_scope'`)
      .get();
    if (present) continue;
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN constraint_scope TEXT`);
    } catch (err) {
      if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err;
    }
  }
  migrateLegacyDescriptors(db);
  if (typeof db.function !== "function") return;
  db.function("memory_scope_visible", { deterministic: false }, (scope: string | null) =>
    currentScopeVisible(typeof scope === "string" ? scope : null) ? 1 : 0,
  );
  db.function("memory_scope_write", { deterministic: false }, () => currentWriteScope());
  db.function("memory_scope_same", { deterministic: false }, (scope: string | null) =>
    (typeof scope === "string" ? scope : null) === currentWriteScope() ? 1 : 0,
  );
}

/**
 * Rewrite descriptors written before `allowedEgress` existed into the
 * current form with an empty list (the strictest reading, which
 * `parseConstraintScope` already gives them), so scope equality (dedup,
 * per-scope passes) treats them as the scope a write now produces.
 * Idempotent: a current descriptor is left as it is.
 */
function migrateLegacyDescriptors(db: ScopeDb): void {
  for (const table of CONSTRAINT_SCOPE_TABLES) {
    const stmt = db.prepare(
      `SELECT DISTINCT constraint_scope AS scope FROM ${table} WHERE constraint_scope IS NOT NULL AND constraint_scope NOT LIKE '%"allowedEgress"%'`,
    );
    if (typeof stmt.all !== "function") return;
    for (const { scope } of stmt.all() as { scope: string }[]) {
      const d = parseConstraintScope(scope);
      if (d === undefined) continue;
      const update = db.prepare(`UPDATE ${table} SET constraint_scope = ? WHERE constraint_scope = ?`);
      update.run?.(constraintScopeOf(d), scope);
    }
  }
}

/** Every distinct scope with live rows on `table`, for per-scope background passes. */
export function listConstraintScopes(
  db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } },
  table: (typeof CONSTRAINT_SCOPE_TABLES)[number] = "memories",
): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT constraint_scope AS scope FROM ${table} WHERE constraint_scope IS NOT NULL ORDER BY scope`)
    .all() as { scope: string }[];
  return rows.map((r) => r.scope);
}

/** The tables whose rows name the folder they were written in. */
const FOLDER_TABLES = ["memories", "lessons", "procedures"] as const;

export interface ConstraintScopeBackfillResult {
  /** Rows tagged by this run, per table. */
  tagged: Record<(typeof FOLDER_TABLES)[number], number>;
  /** Live profile facts with no scope: they name no folder, so nothing can tag them. */
  untaggedProfileFacts: number;
}

interface BackfillDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): { changes: number | bigint }; get(...params: unknown[]): unknown };
  transaction?(fn: () => void): () => unknown;
}

const BACKFILL_META_KEY = "constraint_scope_backfill";

/**
 * Tag the rows written before their folder's constraint existed (or by
 * an older binary): every untagged note, lesson and procedure whose
 * `working_dir` falls under a constraint (`resolvePolicy`, the config
 * matcher) gets that constraint's scope, as if it had been written
 * under it. Without this they stayed visible to every session, and the
 * consolidator's untagged pass distilled them with no constraint.
 * Idempotent: a tagged row is never changed, so removing or widening a
 * constraint does not untag anything. Profile facts name no folder and
 * stay untagged; they are only counted (doctor warns).
 */
export function backfillConstraintScopes(
  db: BackfillDb,
  resolvePolicy: (workingDir: string) => ProviderPolicy | undefined,
): ConstraintScopeBackfillResult {
  const tagged = { memories: 0, lessons: 0, procedures: 0 };
  const run = (): void => {
    for (const table of FOLDER_TABLES) {
      const dirs = db
        .prepare(`SELECT DISTINCT working_dir AS dir FROM ${table} WHERE constraint_scope IS NULL AND working_dir IS NOT NULL AND working_dir != ''`)
        .all() as { dir: string }[];
      const update = db.prepare(`UPDATE ${table} SET constraint_scope = ? WHERE constraint_scope IS NULL AND working_dir = ?`);
      for (const { dir } of dirs) {
        const policy = resolvePolicy(dir);
        if (policy === undefined) continue;
        tagged[table] += Number(update.run(constraintScopeOf(policy), dir).changes);
      }
    }
  };
  if (typeof db.transaction === "function") db.transaction(run)();
  else run();
  const profile = db
    .prepare(`SELECT COUNT(*) AS n FROM profile_facts WHERE constraint_scope IS NULL AND superseded_by IS NULL`)
    .get() as { n: number };
  const result = { tagged, untaggedProfileFacts: Number(profile.n) };
  recordBackfill(db, result);
  return result;
}

export interface ConstraintScopeBackfillRecord {
  /** Rows tagged by every back-fill so far. */
  retroTagged: number;
  untaggedProfileFacts: number;
  at: number;
}

function recordBackfill(db: BackfillDb, result: ConstraintScopeBackfillResult): void {
  const previous = readConstraintScopeBackfillRecord(db);
  const now = result.tagged.memories + result.tagged.lessons + result.tagged.procedures;
  const record: ConstraintScopeBackfillRecord = {
    retroTagged: (previous?.retroTagged ?? 0) + now,
    untaggedProfileFacts: result.untaggedProfileFacts,
    at: Date.now(),
  };
  db.prepare(`INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(BACKFILL_META_KEY, JSON.stringify(record));
}

/** What the back-fills recorded (`atomic-agent doctor`), or `undefined` before the first. */
export function readConstraintScopeBackfillRecord(db: Pick<BackfillDb, "prepare">): ConstraintScopeBackfillRecord | undefined {
  try {
    const row = db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(BACKFILL_META_KEY) as { value: string } | undefined;
    if (row === undefined) return undefined;
    const raw = JSON.parse(row.value) as Partial<ConstraintScopeBackfillRecord>;
    return typeof raw.retroTagged === "number" && typeof raw.untaggedProfileFacts === "number"
      ? { retroTagged: raw.retroTagged, untaggedProfileFacts: raw.untaggedProfileFacts, at: typeof raw.at === "number" ? raw.at : 0 }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The back-fill as the runtime runs it: at startup, and again whenever
 * the `projects.constraints` block differs from the one it last ran
 * with (a constraint added while the runtime is up), checked before
 * each turn and each consolidator tick. `ensure()` returns the run's
 * result, or `null` when nothing changed since the last run.
 */
export function createConstraintScopeBackfill(deps: {
  db: BackfillDb;
  readConstraints: () => unknown;
  resolvePolicy: (workingDir: string) => ProviderPolicy | undefined;
}) {
  let lastFingerprint: string | undefined;
  return {
    ensure(): ConstraintScopeBackfillResult | null {
      const fingerprint = JSON.stringify(deps.readConstraints() ?? {});
      if (fingerprint === lastFingerprint) return null;
      const result = backfillConstraintScopes(deps.db, deps.resolvePolicy);
      lastFingerprint = fingerprint;
      return result;
    },
  };
}

/**
 * Read-only: the untagged rows a back-fill would tag now, and the live
 * untagged profile facts (`atomic-agent doctor`).
 */
export function pendingConstraintScopes(
  db: Pick<BackfillDb, "prepare">,
  resolvePolicy: (workingDir: string) => ProviderPolicy | undefined,
): { pendingRows: number; untaggedProfileFacts: number } {
  let pendingRows = 0;
  for (const table of FOLDER_TABLES) {
    const dirs = db
      .prepare(`SELECT working_dir AS dir, COUNT(*) AS n FROM ${table} WHERE constraint_scope IS NULL AND working_dir IS NOT NULL AND working_dir != '' GROUP BY working_dir`)
      .all() as { dir: string; n: number }[];
    for (const { dir, n } of dirs) if (resolvePolicy(dir) !== undefined) pendingRows += Number(n);
  }
  const profile = db
    .prepare(`SELECT COUNT(*) AS n FROM profile_facts WHERE constraint_scope IS NULL AND superseded_by IS NULL`)
    .get() as { n: number };
  return { pendingRows, untaggedProfileFacts: Number(profile.n) };
}
