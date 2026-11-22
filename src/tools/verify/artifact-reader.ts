import { extname } from "node:path";
import { readArtifactSnapshot } from "./artifact-snapshot.js";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { evaluateDocument, parseDocumentSpec } from "./document-check.js";
import { evaluateSpreadsheet, parseSpreadsheetSpec } from "./spreadsheet-check.js";
import { ARTIFACT_NODE_OPTIONS, type ArtifactJob, type ArtifactOutcome } from "./artifact-process.js";

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
  const extension = extname(path).toLowerCase();
  const supported = kind === "document" ? [".md", ".docx", ".txt", ".pdf"] : [".csv", ".xlsx"];
  const bytes = await readArtifactSnapshot(root, cwd, path, () => {
    if (!supported.includes(extension)) throw new Error(`unsupported ${kind} extension: ${extension}`);
  });
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
