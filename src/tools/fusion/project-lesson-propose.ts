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
  const text = [
    "---", "id: " + id, "title: " + JSON.stringify(title), "source: " + source, "from: " + JSON.stringify(from),
    "touches: " + JSON.stringify(touches), "status: proposed", "always: " + always, "---",
    "## Decided", decided, "## Tried and ruled out", triedAndRuledOut, "## Watch out", watchOut, "",
  ].join("\n");
  validateProjectLessonProposal(id, text);
  return { id, text };
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
      if (isTooBroadScope(folder) || folder !== resolve(ctx.workingDir)) return error(new Error("Run this tool from the project folder."));
      let draft: ReturnType<typeof proposal>;
      let path: string;
      try {
        draft = proposal(args);
        path = projectLessonProposalPath(folder, draft.id);
      } catch (cause) {
        return error(cause);
      }
      await requireFsApproval(options, {
        kind: "write", paths: [path], sessionId: ctx.sessionId, tool,
        reason: "Save a new project lesson proposal", preview: draft.text.slice(0, 400),
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
      return compressToolResult({ tool, status: "ok", output: `Saved proposed lesson ${draft.id}. The person can review it with atomic-agent project lessons.` });
    },
  };
}
