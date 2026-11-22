import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import { PROJECT_BACKLOG_SOURCES, applyBacklogAdd, type ProjectBacklogDraft } from "../../session/project-backlog.js";
import type { ProjectBacklogSource, ProjectUpdate } from "../../session/session-project.js";
import type { ToolDefinition } from "../tool-registry.js";
import { PROJECT_BACKLOG_ADD_TOOL, PROJECT_UPDATE_DETAIL } from "./project-tools.js";

export { PROJECT_BACKLOG_ADD_TOOL };

/**
 * `project.backlog.add` (issue #111): the director proposes an item for
 * the project's backlog — its own idea, one a worker or reviewer named in
 * a reply (`source`, `milestoneId` and `taskId` say whose and from which task; the fold
 * checks that task ran), or one the person asked for ("add to backlog:
 * …", `source: "person"`). The orchestrator's only (`worker-tool-policy`
 * keeps it from workers). It opens no gate and decides nothing: an item
 * starts open, and only the person promotes or drops it
 * (`runtime.projectBacklogDecision`, `atomic-agent project backlog`).
 * Read-only like the other project tools: it changes only the project's
 * own record, through the step's fold.
 */

type Parsed = { ok: true; item: Omit<ProjectBacklogDraft, "id"> } | { ok: false; problems: string[] };

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

export function parseProjectBacklogArgs(raw: Record<string, unknown>): Parsed {
  const problems: string[] = Object.keys(raw)
    .filter((k) => !["title", "note", "condition", "source", "milestoneId", "taskId"].includes(k))
    .map((k) => `unknown key \`${k}\` (an item starts open; only the person decides on it)`);
  if (!nonEmpty(raw.title)) problems.push("`title` must say what the later work is");
  for (const f of ["note", "condition"] as const) {
    if (raw[f] !== undefined && typeof raw[f] !== "string") problems.push(`\`${f}\` must be text`);
  }
  if (typeof raw.source !== "string" || !(PROJECT_BACKLOG_SOURCES as readonly string[]).includes(raw.source)) {
    problems.push(`\`source\` must be one of ${PROJECT_BACKLOG_SOURCES.join(", ")}: who proposed it`);
  }
  for (const f of ["milestoneId", "taskId"] as const) {
    if (raw[f] !== undefined && !nonEmpty(raw[f])) problems.push(`\`${f}\` must name the plan's ${f === "taskId" ? "task" : "milestone"}`);
  }
  const origin: ProjectBacklogDraft["origin"] = raw.milestoneId === undefined && raw.taskId === undefined
    ? undefined
    : {
        ...(nonEmpty(raw.milestoneId) ? { milestoneId: raw.milestoneId.trim() } : {}),
        ...(nonEmpty(raw.taskId) ? { taskId: raw.taskId.trim() } : {}),
      };
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    item: {
      title: raw.title as string,
      source: raw.source as ProjectBacklogSource,
      ...(nonEmpty(raw.note) ? { note: raw.note } : {}),
      ...(nonEmpty(raw.condition) ? { condition: raw.condition } : {}),
      ...(origin === undefined ? {} : { origin }),
    },
  };
}

function refuse(problems: string[]): CompressedToolResult {
  return compressToolResult({ tool: PROJECT_BACKLOG_ADD_TOOL, status: "error", output: `${PROJECT_BACKLOG_ADD_TOOL}: ${problems.join("; ")}.`, details: { field: "args" } });
}

export function buildProjectBacklogTool(): ToolDefinition {
  return {
    name: PROJECT_BACKLOG_ADD_TOOL,
    description: "Propose an item for the project's backlog (later work, an idea, a deferred fix; with a condition it is a seed); only the person promotes or drops it.",
    readonly: true,
    async run(rawArgs, ctx) {
      const parsed = parseProjectBacklogArgs(rawArgs);
      if (!parsed.ok) return refuse(parsed.problems);
      // No id: the fold allocates it against the project as it stands then.
      const item: ProjectBacklogDraft = { ...parsed.item };
      // The fold is the authority; checked here too so the reason reaches the director at once.
      const check = applyBacklogAdd(ctx.project, item, 0);
      if (!check.ok) return refuse([check.error.message]);
      const update: ProjectUpdate = { kind: "backlog_add", item };
      const output = [
        `Backlog item proposed (source ${item.source}): ${item.title}. It gets the next b<n> id when it is recorded; \`### fusion project\` counts it.`,
        ...(item.condition === undefined ? [] : [`A seed: shown to the person with its condition at each plan and milestone gate while it is open.`]),
        "It is a proposal, not part of the plan: only the person promotes it (then draft it into the next plan) or drops it. Say so in your reply; keep working on the current step.",
      ].join(" ");
      return compressToolResult({ tool: PROJECT_BACKLOG_ADD_TOOL, status: "ok", output, details: { [PROJECT_UPDATE_DETAIL]: update } });
    },
  };
}
