import { programName } from "../tools/os/shell-command-guard/command-segments.js";
import { shellSyntax } from "../tools/os/shell/shell-rule-syntax.js";

const RESERVED = new Set(["ATOMIC_AGENT_TOOL_CHILD", "ATOMIC_AGENT_POLICY_STATE_DIR", "ATOMIC_AGENT_POLICY_SYSTEM_PATH", "ATOMIC_AGENT_POLICY_FILE_PINS"]);
const reserved = (word: string) => RESERVED.has(word.toUpperCase().replace(/^env:/i, "").split("=", 1)[0]!);

/** A visible argv check, not an integrity boundary against arbitrary same-account code. */
export function changesPolicyChildMetadata(cmd: string, args: readonly string[], useShell: boolean): boolean {
  if (!/ATOMIC_AGENT_(?:TOOL_CHILD|POLICY_)/i.test([cmd, ...args].join(" "))) return false;
  const segments = useShell ? shellSyntax([cmd, ...args].join(" "), process.platform === "win32" ? "cmd" : "posix").segments : [[cmd, ...args]];
  return segments.some(words => {
    if (words.some((word, index) => word.includes("=") && reserved(word) && (index === 0 || ["env", "export", "set"].includes(programName(words[0] ?? ""))))) return true;
    const name = programName(words[0] ?? "");
    if (["unset", "remove-item", "set-item", "export", "set"].includes(name)) return words.slice(1).some(reserved);
    if (name !== "env") return false;
    return words.slice(1).some((word, index) => /^(?:-u|--unset)$/.test(word) && reserved(words[index + 2] ?? "") || /^--unset=/.test(word) && reserved(word.slice(8)) || /^-u./.test(word) && reserved(word.slice(2)));
  });
}
