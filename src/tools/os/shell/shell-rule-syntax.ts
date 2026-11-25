import { lexShellLine, type ShellDialect } from "../shell-command-guard/shell-line-lexer.js";
import { liftSubstitutions } from "../shell-command-guard/command-substitution.js";

/** Bounded static syntax facts, never an interpreter and never alias/profile loading. */
export function shellSyntax(line: string, dialect: ShellDialect, depth = 0): { segments: string[][]; unreadable: boolean } {
  if (line.length > 128 * 1024 || depth >= 8) return { segments: [], unreadable: true };
  const lifted = dialect === "posix" ? liftSubstitutions(line, true) : { outer: line, inner: [] };
  const tokens = lifted === null ? null : lexShellLine(lifted.outer, dialect);
  if (tokens === null || tokens.length > 16_384) return { segments: [line.slice(0, 4096).split(/\s+/).slice(0, 256)], unreadable: true };
  let unreadable = tokens.some((token, index) => token.kind === "open" && tokens[index - 1]?.kind === "word" && tokens[index + 1]?.kind === "close" && tokens[index + 2]?.kind === "word" && (tokens[index + 2] as { text?: string }).text === "{");
  const segments: string[][] = [];
  let words: string[] = [], redirected = false;
  const flush = () => {
    let command = words; words = [];
    if (command.length === 0) return;
    if (dialect === "posix") {
      if (["for", "select", "case"].includes(command[0]!)) return;
      while (["if", "then", "elif", "else", "while", "until", "do", "!", "coproc"].includes(command[0] ?? "")) command = command.slice(1);
      if (["done", "fi", "esac", "in"].includes(command[0] ?? "")) return;
    }
    if (/^(?:alias|unalias|function|set-alias|new-alias|invoke-expression|iex|\.|--%)$/i.test(command[0] ?? "")) unreadable = true;
    if (dialect === "cmd" && /^(?:if|for|start)$/i.test(command[0] ?? "")) unreadable = true;
    // A bare PowerShell name may be an alias/function supplied by a profile.
    // Keep canonical Verb-Noun commands and qualified executables readable;
    // do not guess an alias's target from the operator's machine.
    if (dialect === "powershell" && !/[\\/]/.test(command[0] ?? "") && !/^[A-Za-z]+-[A-Za-z]+$/.test(command[0] ?? "")) unreadable = true;
    if (command.length > 0) segments.push(command);
  };
  for (const token of tokens) {
    if (token.kind === "redirect") { redirected = true; continue; }
    if (token.kind !== "word") { redirected = false; flush(); continue; }
    if (redirected) { redirected = false; continue; }
    if (token.dynamic) unreadable = true;
    if (dialect !== "cmd" && (token.text === "{" || token.text === "}")) {
      if (token.text === "{" && words.length > 0) unreadable = true;
      flush(); continue;
    }
    words.push(token.text);
  }
  flush();
  for (const inner of lifted?.inner ?? []) {
    const nested = shellSyntax(inner, dialect, depth + 1);
    segments.push(...nested.segments); unreadable ||= nested.unreadable;
  }
  return { segments, unreadable };
}
