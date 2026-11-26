import { programName } from "../tools/os/shell-command-guard/command-segments.js";
import { analyzeShellRules, shellWrapperSegments } from "../tools/os/shell/org-shell-analysis.js";

const RESERVED = new Set(["ATOMIC_AGENT_TOOL_CHILD", "ATOMIC_AGENT_POLICY_STATE_DIR", "ATOMIC_AGENT_POLICY_SYSTEM_PATH", "ATOMIC_AGENT_POLICY_FILE_PINS"]);
const reserved = (word: string) => RESERVED.has(word.toUpperCase().replace(/^env:/i, "").split("=", 1)[0]!);

/** A visible argv check, not an integrity boundary against arbitrary same-account code. */
export function changesPolicyChildMetadata(cmd: string, args: readonly string[], useShell: boolean, analyze = analyzeShellRules): boolean {
  if (!/ATOMIC_AGENT_(?:TOOL_CHILD|POLICY_)|\benv(?:\.exe)?\b|\bexec\b/i.test([cmd, ...args].join(" "))) return false;
  const segments = analyze(cmd, args, useShell).segments.flatMap(words => [words, ...shellWrapperSegments(words)]);
  return segments.some(words => {
    if (words.some((word, index) => word.includes("=") && reserved(word) && (index === 0 || ["env", "export", "set"].includes(programName(words[0] ?? ""))))) return true;
    const name = programName(words[0] ?? "");
    if (["unset", "remove-item", "set-item", "export", "set", "declare", "typeset"].includes(name)) return words.slice(1).some(reserved);
    if (name === "exec") {
      for (let i = 1; i < words.length && words[i]?.startsWith("-") && words[i] !== "--"; i++) {
        for (const flag of words[i]!.slice(1)) {
          if (flag === "c") return true;
          if (flag === "a") { if (words[i] === "-a") i++; break; }
        }
      }
    }
    if (name !== "env") return false;
    for (let i = 1; i < words.length; i++) {
      const word = words[i]!;
      if (word === "--") break;
      if (word === "-" || word === "--ignore-environment") return true;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
      if (!word.startsWith("-")) break;
      if (/^--(?:unset|chdir|split-string)$/.test(word)) { i++; continue; }
      if (word.startsWith("--")) continue;
      for (let j = 1; j < word.length; j++) {
        if (word[j] === "i") return true;
        if ("uCPS".includes(word[j]!)) { if (j === word.length - 1) i++; break; }
      }
    }
    return words.slice(1).some((word, index) => /^(?:-u|--unset)$/.test(word) && reserved(words[index + 2] ?? "") || /^--unset=/.test(word) && reserved(word.slice(8)) || /^-u./.test(word) && reserved(word.slice(2)));
  });
}
