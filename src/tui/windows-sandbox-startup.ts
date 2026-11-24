import { createSetupPrompter } from "../cli/setup-terminal-prompt.js";
import { readOsSandboxSettings } from "../sandbox/os-sandbox.js";
import { projectDecisionOriginRefusal } from "../sandbox/project-decision-origin.js";
import { applyWindowsSandboxGrant, hasWindowsSandboxGrants, planWindowsSandbox } from "../sandbox/windows-sandbox.js";

/** Ask from the interactive terminal before Ink and agent input have started. */
export async function runWindowsSandboxStartup(
  workingDir: string,
  stateDir: string,
  protectedPaths: readonly string[],
  notice: (text: string) => void,
): Promise<void> {
  if (process.platform !== "win32" || projectDecisionOriginRefusal()) return;
  try {
    if (readOsSandboxSettings().mode !== "workspace") {
      if (hasWindowsSandboxGrants(stateDir)) {
        notice("Windows Safe Mode is off. To remove its saved ACL grants, run atomic-agent sandbox windows revoke --all.");
      }
      return;
    }

    const plan = planWindowsSandbox(stateDir, workingDir, protectedPaths);
    if (plan === undefined) return;
    const terminal = createSetupPrompter();
    try {
      const count = plan.approximateFiles > 50_000 ? "50,000+" : String(plan.approximateFiles);
      const reads = plan.readOnlyRoots.map(root => `  ${root}`).join("\n");
      const answer = await terminal.ask(
        `Windows Safe Mode needs permission to add inheritable NTFS access entries.\n` +
        `Project (read, write, execute, about ${count} files): ${plan.root}\n` +
        `Runtime (read and execute):\n${reads}\n` +
        "Grant this access to this project's restricted container? [y/N] ",
      );
      if (answer === "no-tty" || !/^y(?:es)?$/i.test(answer?.trim() ?? "")) {
        notice("Windows sandbox access is unapproved. Safe Mode will refuse commands for this project.");
        return;
      }
      applyWindowsSandboxGrant(plan);
      notice("Windows sandbox access granted. Commands still require a successful isolation probe.");
    } finally {
      terminal.close();
    }
  } catch (error) {
    notice(`Windows sandbox setup failed. ${error instanceof Error ? error.message : String(error)}`);
  }
}
