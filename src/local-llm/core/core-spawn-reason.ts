import type { CoreFailureReason } from "./core-errors.js";

/** OS error shapes only: never inspect process output, paths or messages. */
export function coreSpawnReason(err: unknown): CoreFailureReason {
  if (!err || typeof err !== "object") return "spawn_exit";
  const { code, killed } = err as { code?: unknown; killed?: unknown };
  if (killed === true) return "spawn_timeout";
  if (code === "ENOENT") return "spawn_missing";
  if (code === "EACCES" || code === "EPERM") return "spawn_access";
  if (code === "ENOEXEC" || code === 193 || code === 216 || code === 0xC000007B || code === -1073741701) return "spawn_arch";
  if (code === "EADDRINUSE") return "spawn_port";
  if (code === 0xC0000142 || code === -1073741502 || code === 0xC0000135 || code === -1073741515) return "spawn_dll_init";
  return "spawn_exit";
}

/** A closed, bounded explanation; no stderr is retained even as an Error cause. */
export function coreSpawnDetail(reason: CoreFailureReason): string {
  switch (reason) {
    case "spawn_missing": return "the downloaded binary is missing";
    case "spawn_access": return "permission to run the downloaded binary was denied";
    case "spawn_arch": return "the downloaded binary has the wrong architecture";
    case "spawn_dll_init": return "a required library is missing or could not initialise";
    case "spawn_port": return "the port is already in use";
    case "spawn_timeout": return "the downloaded binary did not answer within 15 seconds";
    default: return "the downloaded binary exited before answering";
  }
}
