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
 * `constraint_scope` column: a JSON descriptor `{"key", "allowedProviders"}`
 * frozen at write time. It is not a tag, so the notes tool, reflection
 * EVOLVE and the reconciler can neither add nor strip it. Untagged rows
 * (`NULL`) are what every session sees.
 *
 * A tagged row is visible to a call whose policy has the same key, or a
 * policy whose allowed list is a subset of the row's (a stricter one:
 * the row's content could only reach providers its own folder already
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
}

/** The `constraint_scope` value of rows written under `policy`. */
export function constraintScopeOf(policy: Pick<ProviderPolicy, "key" | "allowedProviders">): string {
  const allowedProviders = [...new Set(policy.allowedProviders)].sort();
  return JSON.stringify({ key: policy.key, allowedProviders });
}

const parsed = new Map<string, ScopeDescriptor | null>();

/** Parse a stored scope; anything malformed is `undefined` (visible to nobody). */
export function parseConstraintScope(scope: string): ScopeDescriptor | undefined {
  const cached = parsed.get(scope);
  if (cached !== undefined) return cached ?? undefined;
  let value: ScopeDescriptor | null = null;
  try {
    const raw: unknown = JSON.parse(scope);
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const { key, allowedProviders } = raw as Record<string, unknown>;
      if (
        typeof key === "string" &&
        Array.isArray(allowedProviders) &&
        allowedProviders.every((id): id is string => typeof id === "string")
      ) {
        value = { key, allowedProviders };
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
 * row's own key and allowed list. A malformed scope allows nothing.
 */
export function policyForConstraintScope(scope: string): ProviderPolicy {
  const d = parseConstraintScope(scope);
  return d === undefined
    ? makeProviderPolicy({ key: "(unreadable memory scope)", allowedProviders: [], matchedDir: "" })
    : makeProviderPolicy({ key: d.key, allowedProviders: d.allowedProviders, matchedDir: d.key });
}

/** Whether a row of `rowScope` may be read by a call under `policy`. */
export function scopeVisibleTo(rowScope: string | null, policy: ProviderPolicy | undefined): boolean {
  if (rowScope === null) return true;
  if (policy === undefined) return false;
  const row = parseConstraintScope(rowScope);
  if (row === undefined) return false;
  if (row.key === policy.key) return true;
  return policy.allowedProviders.every((id) => row.allowedProviders.includes(id));
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
  prepare(sql: string): { get(...params: unknown[]): unknown };
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
  if (typeof db.function !== "function") return;
  db.function("memory_scope_visible", { deterministic: false }, (scope: string | null) =>
    currentScopeVisible(typeof scope === "string" ? scope : null) ? 1 : 0,
  );
  db.function("memory_scope_write", { deterministic: false }, () => currentWriteScope());
  db.function("memory_scope_same", { deterministic: false }, (scope: string | null) =>
    (typeof scope === "string" ? scope : null) === currentWriteScope() ? 1 : 0,
  );
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
