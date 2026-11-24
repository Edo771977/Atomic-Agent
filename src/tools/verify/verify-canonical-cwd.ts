import { canonicalVerifyPath } from "../../approval/verify-page-folder.js";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function canonicalVerifyCwd(root: string, target: string, preserveRootSpelling = false): string {
  // Native realpath resolves junctions and expands NTFS short names.
  const cwd = canonicalVerifyPath(target);
  const offset = relative(canonicalVerifyPath(root), cwd);
  if (isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`)) {
    throw new Error("verify.run: \`cwd\` must stay inside the working directory");
  }
  // Verify's copy, approval and read-scope APIs use the caller's project
  // spelling. Project the already validated offset back into that namespace.
  return preserveRootSpelling ? resolve(root, offset) : cwd;
}
