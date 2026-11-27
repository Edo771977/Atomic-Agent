/** Shared discovery/write-protection vocabulary; keep consumers on these identities. */
export const rootNames = ["AGENTS.md", "AGENT.md", "CLAUDE.md", ".claude/CLAUDE.md"];
export const foreignRootNames = ["GEMINI.md", ".cursorrules", ".github/copilot-instructions.md"];
export const cursorRulesDir = ".cursor/rules";
export const PROJECT_AGENT_DIRS: readonly string[] = [".atomic-agent/agents", ".claude/agents"];

export function instructionCaseKey(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" || platform === "win32" ? path.toLowerCase() : path;
}
