import { lexShellLine, type ShellDialect } from "../shell-command-guard/shell-line-lexer.js";
import { liftSubstitutions } from "../shell-command-guard/command-substitution.js";

/** Internal analysis marker, never an argv to execute (NUL cannot be a shell word). */
export const UNKNOWN_SHELL_WORD = "\0";

/** References retain trailing group redirections without rescanning its commands. */
export interface ShellInput { parent?: ShellInput; redirected?: true }
export function receivesShellInput(input: ShellInput | undefined): boolean {
  for (let depth = 0; input !== undefined; depth++, input = input.parent) {
    if (input.redirected || depth >= 256) return true;
  }
  return false;
}

/** Bounded static syntax facts, never an interpreter and never alias/profile loading. */
export function shellSyntax(line: string, dialect: ShellDialect, depth = 0): { segments: string[][]; inputs: ShellInput[]; unreadable: boolean } {
  if (line.length > 128 * 1024 || depth >= 8) return { segments: [], inputs: [], unreadable: true };
  const lifted = dialect === "posix" ? liftSubstitutions(line, true) : { outer: line, inner: [] };
  const tokens = lifted === null ? null : lexShellLine(lifted.outer, dialect, undefined, true, false, true);
  if (tokens === null || tokens.length > 16_384) return { segments: [line.slice(0, 4096).split(/\s+/).slice(0, 256)], inputs: [{ redirected: true }], unreadable: true };
  let unreadable = tokens.some((token, index) => token.kind === "open" && tokens[index - 1]?.kind === "word" && tokens[index + 1]?.kind === "close" && tokens[index + 2]?.kind === "word" && (tokens[index + 2] as { text?: string }).text === "{");
  const segments: string[][] = [];
  const inputs: ShellInput[] = [];
  type Frame = { kind: string; base: ShellInput; current: ShellInput };
  const root: ShellInput = {};
  const frames: Frame[] = [{ kind: "root", base: root, current: { parent: root } }];
  const frame = () => frames[frames.length - 1]!;
  const open = (kind: string) => {
    const base = frame().current;
    frames.push({ kind, base, current: { parent: base } });
  };
  const close = (kind: string) => { if (frames.length > 1 && frame().kind === kind) frames.pop(); else if (!(kind === "paren" && frame().kind === "case")) unreadable = true; };
  let words: string[] = [], redirected = false;
  let commandPosition = true, pendingPipe = false;
  const flush = () => {
    let command = words; words = [];
    if (command.length === 0) return;
    if (dialect === "posix") {
      if (["for", "select", "case"].includes(command[0]!)) return;
      while (["if", "then", "elif", "else", "while", "until", "do", "!", "coproc"].includes(command[0] ?? "")) command = command.slice(1);
      if (["done", "fi", "esac", "in"].includes(command[0] ?? "")) return;
    }
    if (/^(?:alias|unalias|function|set-alias|new-alias|invoke-expression|iex|--%)$/i.test(command[0] ?? "") || command[0] === "." && dialect !== "posix") unreadable = true;
    if (dialect === "cmd" && /^(?:if|for|start)$/i.test(command[0] ?? "")) unreadable = true;
    // A bare PowerShell name may be an alias/function supplied by a profile.
    // Keep canonical Verb-Noun commands and qualified executables readable;
    // do not guess an alias's target from the operator's machine.
    if (dialect === "powershell" && !/[\\/]/.test(command[0] ?? "") && !/^[A-Za-z]+-[A-Za-z]+$/.test(command[0] ?? "")) unreadable = true;
    if (command.length > 0) { segments.push(command); inputs.push(frame().current); }
  };
  for (const token of tokens) {
    if (token.kind === "separator" && pendingPipe) unreadable = true;
    if (token.kind === "redirect") {
      if (token.inputFd === 0) frame().current.redirected = true;
      redirected = true; continue;
    }
    if (token.kind !== "word") {
      redirected = false; flush();
      if (token.kind === "open") open("paren");
      else if (token.kind === "close") close("paren");
      else frame().current = { parent: frame().base, ...(token.pipe ? { redirected: true } : {}) };
      commandPosition = true;
      pendingPipe = token.kind === "separator" && token.pipe === true;
      continue;
    }
    if (redirected) { redirected = false; continue; }
    if (dialect !== "cmd" && (token.text === "{" || token.text === "}")) {
      if (token.text === "{" && words.length > 0) unreadable = true;
      flush();
      if (token.literal && commandPosition) {
        if (token.text === "{") open("brace"); else close("brace");
      } else commandPosition = false;
      pendingPipe = false;
      continue;
    }
    if (dialect === "posix" && token.literal && commandPosition) {
      if (["for", "select", "while", "until"].includes(token.text)) open("loop");
      else if (token.text === "if") open("if");
      else if (token.text === "case") open("case");
      else if (token.text === "done") close("loop");
      else if (token.text === "fi") close("if");
      else if (token.text === "esac") close("case");
    }
    commandPosition = dialect === "posix" && token.literal === true && commandPosition && ["if", "then", "elif", "else", "while", "until", "do", "!", "coproc"].includes(token.text);
    pendingPipe = false;
    words.push(token.dynamic && !(dialect === "posix" && token.text === "[") ? (/^[A-Za-z_][A-Za-z0-9_]*=/.exec(token.text)?.[0] ?? "") + UNKNOWN_SHELL_WORD : token.text);
  }
  flush();
  unreadable ||= frames.length !== 1 || pendingPipe || redirected;
  for (const inner of lifted?.inner ?? []) {
    const nested = shellSyntax(inner, dialect, depth + 1);
    segments.push(...nested.segments); inputs.push(...nested.inputs); unreadable ||= nested.unreadable;
  }
  return { segments, inputs, unreadable };
}
