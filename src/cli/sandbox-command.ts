import { resolveStateDir } from "../config/index.js";
import { projectDecisionOriginRefusal } from "./project-decision-origin.js";
import { revokeWindowsSandbox } from "../sandbox/windows-sandbox.js";

const USAGE = "Usage: atomic-agent sandbox windows revoke [--all | <folder>]";

export async function sandboxCommand(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  if (args.length !== 3 || args[0] !== "windows" || args[1] !== "revoke" ||
    !args[2] || (args[2].startsWith("-") && args[2] !== "--all")) {
    process.stderr.write(USAGE + "\n");
    return 2;
  }
  const refusal = projectDecisionOriginRefusal();
  if (refusal) {
    process.stderr.write(refusal + "\n");
    return 1;
  }
  try {
    const count = revokeWindowsSandbox(resolveStateDir(), args[2]);
    process.stdout.write(`Revoked Windows sandbox access for ${count} project(s).\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
