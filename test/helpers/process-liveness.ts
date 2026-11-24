import { readFileSync } from "node:fs";

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      // An orphan can stay in the process table if PID 1 does not reap it.
      // The command name can contain spaces and parentheses.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat[stat.lastIndexOf(")") + 2] !== "Z";
    }
    return true;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ESRCH" || code === "ENOENT") return false;
    throw error;
  }
}
