import { isAbsolute, relative, resolve } from "node:path";

import { hostOfUrl, isLoopbackHost } from "../../llm/offline-network.js";
import { localFileOfUrl } from "../read-scope/read-scope-targets.js";
import type { VerifyRunArgs } from "./verify-run-args.js";

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * A `verify.run` page probe that starts nothing and stays on this
 * machine: `kind: "page"` with no `start` command, `network: false` (the
 * run blocks non-loopback http(s) requests), opening a file inside the
 * project or a loopback http(s) URL. It runs no shell command, so it
 * asks as `verify_page_local` (quiet from level 2, the `auto` coding
 * mode) rather than `shell`. Anything else asks as before. Read-scope
 * and egress guards still run on it; the lexical containment here is
 * only the category decision.
 */
export function isLocalPageProbe(args: VerifyRunArgs, cwd: string, project: string): boolean {
  if (args.kind !== "page" || args.start !== undefined || args.network) return false;
  if (args.path !== undefined) return inside(project, resolve(cwd, args.path));
  if (args.url === undefined) return false;
  const file = localFileOfUrl(args.url);
  if (file !== null) return inside(project, file);
  let protocol: string;
  try {
    protocol = new URL(args.url).protocol;
  } catch {
    return false;
  }
  const host = hostOfUrl(args.url);
  return (protocol === "http:" || protocol === "https:") && host !== null && isLoopbackHost(host);
}
