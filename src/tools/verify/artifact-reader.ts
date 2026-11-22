import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { evaluateDocument, parseDocumentSpec } from "./document-check.js";
import { evaluateSpreadsheet, parseSpreadsheetSpec } from "./spreadsheet-check.js";
import { ARTIFACT_NODE_OPTIONS, type ArtifactJob, type ArtifactOutcome } from "./artifact-process.js";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_MEMBERS = 1024;

// Count actual inflated bytes. A ZIP header's claimed uncompressed length is
// insufficient to bound the work and memory used by an Office parser.
async function checkOfficeBudget(bytes: Buffer): Promise<void> {
  const zip = await JSZip.loadAsync(bytes);
  const members = Object.values(zip.files);
  if (members.length > MAX_MEMBERS) throw new Error("archive exceeds the 1024 member limit");
  let remaining = MAX_EXPANDED_BYTES;
  for (const member of members) {
    if (member.dir) continue;
    for await (const chunk of new Readable().wrap(member.nodeStream("nodebuffer"))) {
      remaining -= chunk.length;
      if (remaining < 0) throw new Error("archive exceeds the 32 MiB expansion limit");
    }
  }
}

async function evaluateFile({ root, cwd, kind, path, spec }: ArtifactJob): Promise<ArtifactOutcome> {
  const project = await realpath(root);
  const target = resolve(project, cwd, path);
  const rel = relative(project, target);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) ||
      relative(target, await realpath(target)) !== "") {
    throw new Error("file must be an unaliased path inside the approved project");
  }
  const extension = extname(target).toLowerCase();
  const supported = kind === "document" ? [".md", ".docx", ".txt", ".pdf"] : [".csv", ".xlsx"];
  if (!supported.includes(extension)) throw new Error(`unsupported ${kind} extension: ${extension}`);
  const info = await stat(target, { bigint: true });
  if (!info.isFile() || info.nlink !== 1n) throw new Error("expected a regular, unlinked file");
  if (info.size > BigInt(MAX_BYTES)) throw new Error("file exceeds the 8 MiB limit");
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let bytes: Buffer;
  try {
    const opened = await file.stat({ bigint: true });
    if (opened.dev !== info.dev || opened.ino !== info.ino || !opened.isFile() ||
        opened.nlink !== 1n || opened.size !== info.size || relative(target, await realpath(target)) !== "") {
      throw new Error("file changed while being opened");
    }
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (used !== Number(opened.size) || after.ctimeNs !== opened.ctimeNs || after.size !== opened.size) {
      throw new Error("file changed while being read");
    }
    bytes = buffer.subarray(0, used);
  } finally { await file.close(); }
  if (extension === ".docx" || extension === ".xlsx") await checkOfficeBudget(bytes);
  return kind === "document"
    ? evaluateDocument(bytes, extension, parseDocumentSpec(spec))
    : evaluateSpreadsheet(bytes, extension, parseSpreadsheetSpec(spec));
}

/** The child accepts exactly one request over the parent's private IPC channel. */
export async function serveArtifactCheck(): Promise<number> {
  if (!process.send) return 2;
  const job = await new Promise<ArtifactJob>(resolveJob => process.once("message", resolveJob));
  let outcome: ArtifactOutcome;
  try {
    const permission = process.permission;
    // Audit mode reports denials through has() but still permits operations.
    // The launcher supplies the exact enforcing options as well as the IPC.
    if (process.env.NODE_OPTIONS !== ARTIFACT_NODE_OPTIONS || !permission?.has("fs.read") ||
        ["fs.write", "net", "child", "worker", "addon", "wasi", "ffi", "inspector"].some((scope) => permission.has(scope))) {
      throw new Error("offline artifact reader restrictions are unavailable");
    }
    outcome = await evaluateFile(job);
  } catch (error) {
    outcome = {
      status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "fail" : "uncheckable",
      detail: error instanceof Error ? error.message : "artifact could not be read",
    };
  }
  await new Promise<void>((done, reject) => process.send!(outcome, error => error ? reject(error) : done()));
  process.disconnect();
  return 0;
}
