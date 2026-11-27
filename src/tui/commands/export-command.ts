import { homedir } from "node:os";
import { extname } from "node:path";

import {
  encodeWinAnsi,
  exportChat,
  parseChatExportFormat,
  type ChatExportFormat,
  type SessionState,
} from "../../session/index.js";
import { describeToolCall } from "../../tools/describe-tool-call.js";
import { getConfig } from "../../config/index.js";
import { runtimeKnownSecrets } from "../../runtime/runtime-known-secrets.js";
import { isIncognitoSession } from "../../session/incognito.js";

/**
 * `/export [md|docx|pdf|html] [path]` (ATO-1054): save the open chat as a
 * file with the same exporter as `atomic-agent export`.
 *
 * Modelled on Claude Code's `/export <filename>`, which writes the
 * conversation to that file in the current folder and says where: bare
 * `/export` here writes Markdown named after the chat into the folder
 * the terminal was started in, never over an existing file; a path is
 * written as given, with exclusive creation unless `--force` is supplied. Claude
 * Code's bare `/export` opens a copy-or-save dialog; there is no
 * clipboard step here, the saved path is the answer.
 */

export { resolveExportPath } from "../../session/chat-export-file.js";
import { resolveExportPath, writeExportFile, type ChatExportRequest } from "../../session/chat-export-file.js";
export type { ChatExportRequest } from "../../session/chat-export-file.js";

const FORMAT_WORDS = new Set(["md", "markdown", "docx", "word", "pdf", "html", "htm"]);

const EXTENSION_FORMAT: Record<string, ChatExportFormat> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".docx": "docx",
  ".pdf": "pdf",
  ".html": "html",
  ".htm": "html",
};

function unquote(text: string): string {
  const t = text.trim();
  return t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0] ? t.slice(1, -1) : t;
}

/**
 * The arguments after `/export`: a leading format word, then the path
 * (spaces allowed, quotes optional). Without a format word the whole
 * argument is the path and its extension picks the format (Markdown when
 * it names none), so `/export notes` writes `notes.md`.
 */
export function parseExportCommand(rawArgs: string): ChatExportRequest {
  const flags: { force?: boolean; incognitoConfirmed?: boolean; error?: string } = {};
  // Quoted paths remain literal. Unquoted options work before or after the
  // format/path, and unknown options can never silently become a filename.
  rawArgs = rawArgs.replace(/"[^"]*"|'[^']*'|(^|\s)(--\S+)(?=\s|$)/g, (match, space: string | undefined, flag: string | undefined) => {
    if (!flag) return match;
    if (flag === "--force") flags.force = true;
    else if (flag === "--confirm-incognito") flags.incognitoConfirmed = true;
    else flags.error = `unknown export option: ${flag}`;
    return space ?? "";
  });
  const args = rawArgs.trim();
  if (args.length === 0) return { format: "markdown", path: null, ...flags };
  const first = args.split(/\s+/, 1)[0] ?? "";
  if (FORMAT_WORDS.has(first.toLowerCase())) {
    const format = parseChatExportFormat(first) ?? "markdown";
    const path = unquote(args.slice(first.length));
    return { format, path: path.length > 0 ? path : null, ...flags };
  }
  const path = unquote(args);
  return { format: EXTENSION_FORMAT[extname(path).toLowerCase()] ?? "markdown", path, ...flags };
}

const FORMAT_LABEL: Record<ChatExportFormat, string> = { markdown: "Markdown", html: "HTML", docx: "Word", pdf: "PDF" };

/**
 * Write `state` as `request` asks and return the line for the chat:
 * where it went, or why it did not.
 */
export async function writeChatExport(
  state: SessionState | null,
  request: ChatExportRequest,
  cwd: string = process.cwd(),
): Promise<string> {
  if (request.error) return `export failed: ${request.error}`;
  if (!state || !state.turns.some((t) => t.kind === "user")) return "nothing to export yet: this chat has no messages";
  if (isIncognitoSession(state) && request.incognitoConfirmed !== true) {
    return "incognito chat: exporting leaves a permanent file. To confirm, repeat /export with --confirm-incognito.";
  }
  let path = "";
  try {
    const options = { knownSecrets: runtimeKnownSecrets(getConfig()) };
    path = resolveExportPath(state, request, cwd, homedir(), options);
    const file = await exportChat(state, request.format, {
      ...options,
      describeToolCall: (call) => describeToolCall({ name: call.tool, args: call.args, ok: call.ok }).line,
    });
    const failed = writeExportFile(path, file.body, request.force === true);
    if (failed) return `export failed (${path}): ${failed}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return "export failed: file already exists; use --force to overwrite it";
    const reason = error instanceof Error ? error.message : String(error);
    return `export failed${path ? ` (${path})` : ""}: ${reason}`;
  }
  const note =
    request.format === "pdf" && encodeWinAnsi(state.turns.map((t) => ("text" in t ? t.text : "")).join("\n")).changed > 0
      ? ". The PDF uses the standard fonts, so text outside Western European scripts is transliterated or shown as ?; Markdown and Word keep it"
      : "";
  return `chat exported as ${FORMAT_LABEL[request.format]}: ${path}${note}`;
}
