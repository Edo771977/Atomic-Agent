import { homedir } from "node:os";

import type { SessionState } from "../session/index.js";

import { goalIdeaInputs } from "./idea-goal-source.js";
import { buildIdeaCandidates } from "./idea-rules.js";
import type { IdeaStore, IdeaSyncResult } from "./idea-store.js";
import type { IdeaRecord } from "./idea-types.js";
import type { TaskStore } from "./task-store.js";
import {
  TASK_USER_MESSAGE_MAX_LENGTH,
  TaskValidationError,
  type TaskNotifyTarget,
  type TaskRecord,
} from "./task-types.js";

/**
 * The three things a person (CLI, HTTP, a desktop card) does with
 * suggestions (ATO-458): refresh them from local records, accept one
 * (it becomes a task), dismiss one (its source is never offered again).
 */

/** Tasks and chats a refresh looks at; both newest first. */
export const IDEA_REFRESH_TASK_SCAN = 200;
export const IDEA_REFRESH_SESSION_SCAN = 50;

export interface IdeaRefreshDeps {
  ideas: Pick<IdeaStore, "sync">;
  tasks: Pick<TaskStore, "list">;
  sessions: { listRecent(limit?: number): Pick<SessionState, "id" | "metadata">[] };
  /**
   * A chat's provider policy now (issue #68): a stamp, `null` when
   * unrestricted, `undefined` when unknown (the chat is gone, no
   * constraint is configured). Recorded on a Retry card so the retry
   * keeps the restriction after the chat is deleted.
   */
  sourcePolicy?: (sessionId: string) => Record<string, unknown> | null | undefined;
  now?: number;
}

export function refreshIdeas(deps: IdeaRefreshDeps): IdeaSyncResult {
  const now = deps.now ?? Date.now();
  const tasks = deps.tasks.list({ limit: IDEA_REFRESH_TASK_SCAN }).filter((task) => task.incognito !== true);
  const candidates = buildIdeaCandidates({
    tasks,
    goals: goalIdeaInputs(deps.sessions.listRecent(IDEA_REFRESH_SESSION_SCAN)),
    now,
  });
  const sourcePolicy = deps.sourcePolicy;
  if (sourcePolicy === undefined) return deps.ideas.sync(candidates, now);
  const sessionOf = new Map(tasks.map((t) => [t.id, t.sessionId]));
  return deps.ideas.sync(candidates.map((c) => {
    const taskId = ideaSourceTaskId(c);
    const sessionId = taskId === null ? null : sessionOf.get(taskId) ?? null;
    if (sessionId === null) return c;
    const policy = sourcePolicy(sessionId);
    return policy === undefined ? c : { ...c, sourcePolicy: policy };
  }), now);
}

/**
 * What a "Retry" card brings over from the task it retries, so the rerun
 * keeps the person's limits and folder instead of starting uncapped in
 * the default one: the original's step, spend and time ceilings, its
 * notify target, and the working folder of the chat it ran in. The rerun
 * still opens a fresh chat (a blocked task is often blocked by its chat).
 */
export interface IdeaTaskCarry {
  /** The task the idea retries. */
  sourceTaskId: string;
  maxSteps: number | null;
  maxCostUsd: number | null;
  maxDurationMs: number | null;
  notify: TaskNotifyTarget | null;
  /** The original chat's folder; `null` when it is unknown or gone. */
  workingDir: string | null;
  /**
   * The original chat, for its provider restriction (issue #68): the
   * rerun's chat keeps it. `null` when the task had no chat or it is gone.
   */
  sourceSession: { id: string; workingDir: string; metadata?: Record<string, unknown> } | null;
  /** The original task named a chat that no longer loads: its restriction is unknown. */
  sourceSessionMissing: boolean;
}

/** Where `acceptIdea` looks the original task and its chat up. */
export interface IdeaCarrySource {
  tasks: Pick<TaskStore, "get">;
  sessions: { load(id: string): (Pick<SessionState, "workingDir"> & Partial<Pick<SessionState, "metadata">>) | null };
}

/** How the accepted idea becomes a task: the caller's own create path. */
export type IdeaTaskFactory = (input: {
  sessionId: string | null;
  userMessage: string;
  /** Set for a `retry_task` idea whose original task still exists. */
  carry: IdeaTaskCarry | null;
  /** A `retry_task` idea (its `carry` is `null` when the original task is gone). */
  retry: boolean;
  /** The original chat's policy recorded on the card (`IdeaCandidate.sourcePolicy`). */
  recordedPolicy?: Record<string, unknown> | null;
}) => TaskRecord;

/**
 * Thrown by a task factory when a Retry card can never be accepted (its
 * original chat's restriction cannot be known, issue #68): `acceptIdea`
 * retires the card instead of offering it again.
 */
export class IdeaUnavailableError extends TaskValidationError {
  constructor(message: string) {
    super("sessionId", message);
    this.name = "IdeaUnavailableError";
  }
}

export interface AcceptedIdea {
  idea: IdeaRecord;
  task: TaskRecord;
}

export interface AcceptIdeaOptions {
  /** The edited prompt; omitted keeps the card's. */
  prompt?: string;
  /** Lets a Retry card carry over the original task's limits and folder. */
  carryFrom?: IdeaCarrySource;
  now?: number;
}

/** The task a `retry_task` idea was built from, or `null` for other kinds. */
export function ideaSourceTaskId(idea: Pick<IdeaRecord, "kind" | "sourceKey" | "evidence">): string | null {
  if (idea.kind !== "retry_task") return null;
  if (idea.evidence.source === "task" && idea.evidence.ref) return idea.evidence.ref;
  return idea.sourceKey.startsWith("task:") ? idea.sourceKey.slice("task:".length) : null;
}

/** What a Retry card carries over, or `null` when the original task is gone. */
export function ideaTaskCarry(
  idea: Pick<IdeaRecord, "kind" | "sourceKey" | "evidence">,
  source: IdeaCarrySource,
): IdeaTaskCarry | null {
  const taskId = ideaSourceTaskId(idea);
  if (taskId === null) return null;
  const original = source.tasks.get(taskId);
  if (original === null) return null;
  const session = original.sessionId ? source.sessions.load(original.sessionId) : null;
  return {
    sourceTaskId: original.id,
    maxSteps: original.maxSteps,
    maxCostUsd: original.maxCostUsd,
    maxDurationMs: original.maxDurationMs,
    notify: original.notify,
    workingDir: session?.workingDir ?? null,
    sourceSession: session && original.sessionId
      ? { id: original.sessionId, workingDir: session.workingDir, ...(session.metadata === undefined ? {} : { metadata: session.metadata }) }
      : null,
    sourceSessionMissing: original.sessionId !== null && session === null,
  };
}

/**
 * Accept a `new` idea, optionally with an edited prompt. The status
 * flips first (compare-and-swap), so two accepts of the same card file
 * one task; if the task is refused the idea goes back to `new`.
 * With `carryFrom`, a Retry card hands the factory the original task's
 * limits, notify target and folder (`IdeaTaskCarry`).
 * Returns `null` for an unknown id; throws `IdeaStateError` when the
 * idea was already decided and `TaskValidationError` for a bad prompt.
 */
export function acceptIdea(
  ideas: Pick<IdeaStore, "get" | "claimForAccept" | "attachTask" | "release" | "dismiss">,
  createTask: IdeaTaskFactory,
  id: string,
  options: AcceptIdeaOptions = {},
): AcceptedIdea | null {
  const now = options.now ?? Date.now();
  const prompt = options.prompt === undefined ? null : validatePrompt(options.prompt);
  const before = ideas.get(id);
  if (before === null) return null;
  const carry = options.carryFrom ? ideaTaskCarry(before, options.carryFrom) : null;
  const claimed = ideas.claimForAccept(id, prompt, now);
  if (claimed === null) return null;
  let task: TaskRecord;
  try {
    task = createTask({
      sessionId: claimed.sessionId,
      userMessage: claimed.prompt,
      carry,
      retry: ideaSourceTaskId(before) !== null,
      ...(before.sourcePolicy === undefined ? {} : { recordedPolicy: before.sourcePolicy }),
    });
  } catch (err) {
    ideas.release(id, before.prompt, now);
    if (err instanceof IdeaUnavailableError) ideas.dismiss(id, now);
    throw err;
  }
  const idea = ideas.attachTask(id, task.id, now) ?? { ...claimed, taskId: task.id };
  return { idea, task };
}

function validatePrompt(raw: string): string {
  const prompt = raw.trim();
  if (prompt.length === 0) {
    throw new TaskValidationError("userMessage", "prompt must not be empty");
  }
  if (prompt.length > TASK_USER_MESSAGE_MAX_LENGTH) {
    throw new TaskValidationError(
      "userMessage",
      `prompt must be at most ${TASK_USER_MESSAGE_MAX_LENGTH} characters`,
    );
  }
  return prompt;
}

/** JSON shape shared by the HTTP routes and `atomic-agent ideas`. */
export function ideaToJson(idea: IdeaRecord): Record<string, unknown> {
  return {
    id: idea.id,
    kind: idea.kind,
    status: idea.status,
    title: idea.title,
    reason: idea.reason,
    evidence: idea.evidence,
    prompt: idea.prompt,
    sessionId: idea.sessionId,
    sourceTaskId: ideaSourceTaskId(idea),
    taskId: idea.taskId,
    createdAt: idea.createdAt,
    updatedAt: idea.updatedAt,
    decidedAt: idea.decidedAt,
  };
}

/**
 * Where a Retry card's new chat opens when its original folder is gone
 * and a restriction must be carried (issue #68): the home folder, the
 * same for `serve` and `atomic-agent ideas accept` (neither knows which
 * folder the process draining the task will use). An unrestricted retry
 * opens no chat there; its task runs where the draining runtime works.
 */
export function ideaRetryFallbackDir(): string {
  return homedir();
}
