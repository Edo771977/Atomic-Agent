import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { PROJECT_LIMITS } from "../../session/project-limits.js";
import {
  projectLessonProposalPath, validateProjectLessonProposal, writeProjectLessonProposal,
} from "../../session/project-lessons.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import { requireFsApproval, type FsDangerousToolOptions } from "../os/fs/fs-require-approval.js";
import type { ToolDefinition } from "../tool-registry.js";
import { isTooBroadScope } from "./scope-path.js";
import { PROJECT_LESSON_PROPOSE_TOOL } from "./project-tools.js";

const sections = ["decided", "triedAndRuledOut", "watchOut"] as const;
const fields = ["id", "title", "source", "from", "touches", "always", ...sections];

function proposal(raw: Record<string, unknown>) {
  const { id, title, source, from, touches, always, decided, triedAndRuledOut, watchOut } = raw;
  if (Object.keys(raw).some((key) => !fields.includes(key))) throw new Error("Unexpected field. The tool always writes status: proposed.");
  if (typeof id !== "string" || typeof title !== "string" || typeof from !== "string" ||
      (source !== "director" && source !== "correction" && source !== "milestone-failure") ||
      !Array.isArray(touches) || touches.length > PROJECT_LIMITS.lessonTouches || touches.some((path) => typeof path !== "string") ||
      typeof always !== "boolean" || typeof decided !== "string" || typeof triedAndRuledOut !== "string" ||
      typeof watchOut !== "string" || ![decided, triedAndRuledOut, watchOut].some((section) => section.trim() !== "")) {
    throw new Error("Expected id, title, source, from, touches, always and three lesson sections, with at least one section filled.");
  }
  if ([decided, triedAndRuledOut, watchOut].some(section => section.length > PROJECT_LIMITS.text)) {
    throw new Error(`Lesson sections must be at most ${PROJECT_LIMITS.text} characters each.`);
  }
  const text = [
    "---", "id: " + id, "title: " + JSON.stringify(title), "source: " + source, "from: " + JSON.stringify(from),
    "touches: " + JSON.stringify(touches), "status: proposed", "always: " + always, "---",
    "## Decided", decided, "## Tried and ruled out", triedAndRuledOut, "## Watch out", watchOut, "",
  ].join("\n");
  validateProjectLessonProposal(id, text);
  return { id, source, from, text };
}

export function sameLessonProjectFolder(a: string, b: string, platform = process.platform): boolean {
  return platform === "win32" || platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function buildProjectLessonTool(options: FsDangerousToolOptions & { trustConfigPaths?: readonly string[] }): ToolDefinition {
  const tool = PROJECT_LESSON_PROPOSE_TOOL;
  const error = (cause: unknown) => compressToolResult({ tool, status: "error", output: (cause as Error).message });
  return {
    name: tool,
    description: "Save a new project lesson proposal for the person to review.",
    readonly: false,
    async run(args, ctx) {
      if (ctx.projectRef === undefined || ctx.project === undefined || ctx.project.cancelledAt !== undefined || ctx.incognito) {
        return error(new Error("Lesson proposals require an open, non-incognito project."));
      }
      const folder = resolve(ctx.projectRef.folder);
      const workingDir = resolve(ctx.workingDir);
      let draft: ReturnType<typeof proposal>;
      let path: string;
      try {
        if (isTooBroadScope(folder) || !sameLessonProjectFolder(folder, workingDir) ||
            (folder !== workingDir && realpathSync.native(folder) !== realpathSync.native(workingDir))) {
          throw new Error("Run this tool from the project folder.");
        }
        draft = proposal(args);
        const origin = /^milestone ([^, ]+)(?:, run ([^, ]+))?$/.exec(draft.from);
        const milestone = origin === null ? undefined : ctx.project.milestones.find(item => item.id === origin[1]);
        const runId = origin?.[2];
        const runs = milestone === undefined ? [] : [...milestone.runIds, ...(milestone.history ?? []).flatMap(item => item.runIds)];
        if (milestone === undefined || (runId !== undefined && !runs.includes(runId)) ||
            (runId === undefined && draft.source !== "director" && runs.length > 0)) {
          throw new Error("Use from: milestone <id>, run <id> with recorded project evidence. Omit the run only for a director summary or when no run was recorded.");
        }
        path = projectLessonProposalPath(folder, draft.id);
      } catch (cause) {
        return error(cause);
      }
      await requireFsApproval(options, {
        kind: "write", paths: [path], sessionId: ctx.sessionId, tool,
        reason: draft.text.length > 400 ? "Save a new project lesson proposal (preview truncated)" : "Save a new project lesson proposal",
        preview: draft.text.slice(0, 400),
        targetPaths: [path], affectedResources: [path], workingDir: ctx.workingDir,
        trustConfigPaths: options.trustConfigPaths,
      }, ctx.signal);
      ctx.signal?.throwIfAborted();
      try {
        if (projectLessonProposalPath(folder, draft.id) !== path) throw new Error("The lesson path changed while waiting for approval.");
        writeProjectLessonProposal(folder, draft.id, draft.text);
      } catch (cause) {
        return error(cause);
      }
      return compressToolResult({ tool, status: "ok", output: `Saved director-authored lesson proposal ${draft.id} (declared origin: ${draft.source}, ${draft.from}). The person can review it with atomic-agent project lessons.` });
    },
  };
}
