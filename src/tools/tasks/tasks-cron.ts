import { compressToolResult } from "../../compressor/result-compressor.js";
import { TaskValidationError, validateSchedule, type TaskRunner, type TaskSchedule } from "../../tasks/index.js";
import type { SessionState } from "../../session/index.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { TaskSessionInput } from "./tasks-schedule.js";

export interface TasksCronToolOptions {
  taskRunner: TaskRunner;
  /**
   * Provisions the recurring session from the calling session (its
   * folder and provider constraint, issue #33) instead of letting the
   * runner create one in the runtime's folder. Absent: the runner does.
   */
  createSession?(input?: TaskSessionInput): SessionState;
}

/**
 * `tasks.cron { userMessage, expression, tz? }` — schedule recurring
 * work. Unlike `tasks.schedule`, this tool **never** inherits the
 * caller's session: recurring runs deserve their own persistent
 * session so background autonomy never pollutes the user's active
 * thread. The runner's `create()` path will provision that session
 * up-front because `sessionId` is omitted and the schedule is
 * recurring (see `TaskRunner.create` resolution rules).
 *
 * Validation (cron expression, optional IANA tz) is performed at
 * dispatch time by `resolveScheduledFor` via `cron-parser`; errors
 * surface as `status: error` tool results rather than throws.
 */
export function buildTasksCronTool(
  options: TasksCronToolOptions,
): ToolDefinition {
  return {
    name: "tasks.cron",
    description:
      "Schedule a recurring task via a standard 5- or 6-field cron expression. Args: { userMessage, expression, tz?, notify? }. Each firing runs in its own persistent session (not the caller's). Set notify: \"telegram\" to send each firing's final result to the paired Telegram chat, or notify: \"push\" for a short phone push (ntfy).",
    readonly: false,
    async run(rawArgs, ctx) {
      const userMessage = rawArgs.userMessage;
      const expression = rawArgs.expression;
      if (typeof userMessage !== "string" || userMessage.length === 0) {
        return compressToolResult({
          tool: "tasks.cron",
          status: "error",
          output: "validation: userMessage must be a non-empty string",
          details: { field: "userMessage" },
        });
      }
      if (typeof expression !== "string" || expression.length === 0) {
        return compressToolResult({
          tool: "tasks.cron",
          status: "error",
          output: "validation: expression must be a non-empty cron string",
          details: { field: "expression" },
        });
      }
      const tz = rawArgs.tz;
      if (tz !== undefined && typeof tz !== "string") {
        return compressToolResult({
          tool: "tasks.cron",
          status: "error",
          output: "validation: tz must be a string when provided",
          details: { field: "tz" },
        });
      }
      const notify = rawArgs.notify;
      if (notify !== undefined && notify !== "telegram" && notify !== "push") {
        return compressToolResult({
          tool: "tasks.cron",
          status: "error",
          output: 'validation: notify must be "telegram" or "push" when provided',
          details: { field: "notify" },
        });
      }
      try {
        const schedule: TaskSchedule = {
          kind: "cron",
          expression,
          ...(typeof tz === "string" ? { tz } : {}),
        };
        // Validate before provisioning, so a bad expression leaves no session behind.
        if (options.createSession) validateSchedule(schedule, Date.now());
        const sessionId = options.createSession?.({
          metadata: { recurringTask: true, scheduleKind: "cron", scheduledBy: ctx.sessionId },
          parent: { sessionId: ctx.sessionId, workingDir: ctx.workingDir },
        }).id;
        const record = options.taskRunner.create({
          ...(sessionId === undefined ? {} : { sessionId }),
          userMessage,
          origin: "agent",
          triggerSource: "agent",
          maxAttempts: 1,
          maxSteps: null,
          ...(notify === "telegram" || notify === "push" ? { notify } : {}),
          schedule,
        });
        return compressToolResult({
          tool: "tasks.cron",
          status: "ok",
          output: `scheduled recurring task ${record.id} (next: ${
            record.scheduledFor
              ? new Date(record.scheduledFor).toISOString()
              : "unknown"
          })`,
          details: {
            id: record.id,
            sessionId: record.sessionId,
            scheduledFor: record.scheduledFor,
            expression,
            tz: typeof tz === "string" ? tz : null,
            notify: record.notify,
          },
        });
      } catch (err) {
        if (err instanceof TaskValidationError) {
          return compressToolResult({
            tool: "tasks.cron",
            status: "error",
            output: `validation: ${err.field}: ${err.message}`,
            details: { field: err.field, reason: err.message },
          });
        }
        throw err;
      }
    },
  };
}
