import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_BYTES = 8 * 1024 * 1024;

/** Copy bytes only from an approved regular file, rejecting links and concurrent changes. */
export async function readArtifactSnapshot(root: string, cwd: string, path: string, validateExtension?: () => void): Promise<Buffer> {
  const project = await realpath(root);
  const target = resolve(project, cwd, path);
  const rel = relative(project, target);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) ||
      relative(target, await realpath(target)) !== "") {
    throw new Error("file must be an unaliased path inside the approved project");
  }
  validateExtension?.();
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
  return bytes;
}
