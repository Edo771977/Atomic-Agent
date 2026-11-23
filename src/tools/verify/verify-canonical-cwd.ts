import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

export function canonicalVerifyCwd(root: string, target: string): string {
  // Native realpath resolves junctions and expands NTFS short names.
  const cwd = realpathSync.native(target);
  const offset = relative(realpathSync.native(root), cwd);
  if (isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`)) {
    throw new Error("verify.run: \`cwd\` must stay inside the working directory");
  }
  return cwd;
}
