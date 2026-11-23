import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isCuratableSkillName } from "../curator/skill-curator-config.js";
import { LEARNED_SKILL_LIMITS } from "./skill-lint.js";
import { newLearnedId, type LearnedAction } from "./learned-journal.js";

/** Drafts are scoped to a project and kept outside skill discovery. */
export const PENDING_DRAFT_LIMIT = 20;

export interface PendingDraft {
  /** Short id the owner types; reused as the learned id once approved. */
  id: string;
  kind: LearnedAction;
  /** Skill folder name: the new skill, or the one a patch rewrites. */
  name: string;
  /** The review's one-line reason. */
  reason: string;
  /** Outside sources the turn read (the approval gate's taint labels). */
  sources: string[];
  /** Where the turn came from (`telegram`, `http`, ...). */
  origin?: string;
  /** Epoch ms. */
  createdAt: number;
  sessionId?: string;
  /** sha256 of the target SKILL.md when the draft was made (patch only). */
  targetHash?: string;
}

export const PENDING_ID_PATTERN = /^[0-9a-f]{4,16}$/;

export function pendingDraftsDir(stateDir: string): string {
  return join(stateDir, "skills-pending");
}

/** The draft's SKILL.md, the file `show` points the person at. */
export function pendingDraftSkillFile(stateDir: string, id: string): string {
  return join(pendingDraftsDir(stateDir), id, "SKILL.md");
}

export function hashSkillText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function parseDraft(raw: string, folder: string): PendingDraft | null {
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.id !== folder || typeof obj.id !== "string" || !PENDING_ID_PATTERN.test(obj.id)) return null;
  if (obj.kind !== "create" && obj.kind !== "patch") return null;
  if (typeof obj.name !== "string" || !isCuratableSkillName(obj.name)) return null;
  if (typeof obj.createdAt !== "number" || !Number.isFinite(obj.createdAt) || Math.abs(obj.createdAt) > 8.64e15) return null;
  if (obj.kind === "patch" && typeof obj.targetHash !== "string") return null;
  return {
    id: obj.id,
    kind: obj.kind,
    name: obj.name,
    reason: typeof obj.reason === "string" ? obj.reason : "",
    sources: Array.isArray(obj.sources) ? obj.sources.filter((s): s is string => typeof s === "string").slice(0, 20) : [],
    createdAt: obj.createdAt,
    ...(typeof obj.origin === "string" ? { origin: obj.origin } : {}),
    ...(typeof obj.sessionId === "string" ? { sessionId: obj.sessionId } : {}),
    ...(typeof obj.targetHash === "string" ? { targetHash: obj.targetHash } : {}),
  };
}

/** One draft and its SKILL.md text; `null` when absent or unreadable. */
export async function readPendingDraft(stateDir: string, id: string): Promise<{ draft: PendingDraft; content: string } | null> {
  if (!PENDING_ID_PATTERN.test(id)) return null;
  const dir = join(pendingDraftsDir(stateDir), id);
  try {
    if (await realpath(dir) !== dir || !(await lstat(dir)).isDirectory()) return null;
    const skillFile = join(dir, "SKILL.md");
    const file = await lstat(skillFile);
    const meta = await lstat(join(dir, "draft.json"));
    if (!file.isFile() || file.size > LEARNED_SKILL_LIMITS.maxBytes || !meta.isFile() || meta.size > 16_384) return null;
    const draft = parseDraft(await readFile(join(dir, "draft.json"), "utf8"), id);
    if (draft === null) return null;
    const bytes = await readFile(skillFile);
    const content = bytes.toString("utf8");
    if (bytes.length > LEARNED_SKILL_LIMITS.maxBytes || !Buffer.from(content).equals(bytes)) return null;
    return { draft, content };
  } catch {
    return null;
  }
}

/** Every readable draft, oldest first. */
export async function listPendingDrafts(stateDir: string): Promise<PendingDraft[]> {
  let names: string[];
  try {
    names = (await readdir(pendingDraftsDir(stateDir), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const out: PendingDraft[] = [];
  for (const name of names) {
    if (!PENDING_ID_PATTERN.test(name)) continue;
    try {
      const metadata = join(pendingDraftsDir(stateDir), name, "draft.json");
      const info = await lstat(metadata);
      if (!info.isFile() || info.size > 16_384) continue;
      const draft = parseDraft(await readFile(metadata, "utf8"), name);
      if (draft) out.push(draft);
    } catch {
      // half-written or foreign folder: not listed
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Delete one draft; false when there was none with that id. */
export async function removePendingDraft(stateDir: string, id: string): Promise<boolean> {
  if (!PENDING_ID_PATTERN.test(id)) return false;
  const dir = join(pendingDraftsDir(stateDir), id);
  if (await realpath(dir).catch(() => null) !== dir || !(await lstat(dir)).isDirectory()) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

export interface SavePendingDraftInput {
  kind: LearnedAction;
  name: string;
  reason: string;
  content: string;
  sources: readonly string[];
  origin?: string;
  sessionId?: string;
  targetHash?: string;
  /** Ids already in use (the learned journal), so an approved draft keeps its id. */
  usedIds?: ReadonlySet<string>;
  now?: () => number;
  limit?: number;
}

/**
 * Store a draft, then drop the oldest ones past the cap so drafts from a
 * busy channel cannot pile up. The caller has already run the linter and
 * the security scan.
 */
export async function savePendingDraft(stateDir: string, input: SavePendingDraftInput): Promise<PendingDraft> {
  const now = input.now ?? Date.now;
  const root = pendingDraftsDir(stateDir);
  const existing = new Set((await listPendingDrafts(stateDir)).map((d) => d.id));
  let id = newLearnedId();
  while (existing.has(id) || input.usedIds?.has(id)) id = newLearnedId();
  const draft: PendingDraft = {
    id,
    kind: input.kind,
    name: input.name,
    reason: input.reason,
    sources: [...input.sources].slice(0, 20),
    createdAt: now(),
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.targetHash !== undefined ? { targetHash: input.targetHash } : {}),
  };
  // Written under a temporary name and renamed, so a listing never sees half a draft.
  const tmp = join(root, `.tmp-${id}-${process.pid}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await realpath(root) !== root) throw new Error("The learned draft directory is not canonical.");
  await mkdir(tmp, { mode: 0o700 });
  await writeFile(join(tmp, "SKILL.md"), input.content, { mode: 0o600 });
  await writeFile(join(tmp, "draft.json"), `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, join(root, id));

  const limit = input.limit ?? PENDING_DRAFT_LIMIT;
  const all = await listPendingDrafts(stateDir);
  for (const old of all.slice(0, Math.max(0, all.length - limit))) {
    await rm(join(root, old.id), { recursive: true, force: true });
  }
  return draft;
}
