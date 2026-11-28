import { lexShellLine, type ShellDialect, type ShellToken } from "../shell-command-guard/shell-line-lexer.js";
import { liftSubstitutions } from "../shell-command-guard/command-substitution.js";
import { posix } from "node:path";

/** Internal analysis marker, never an argv to execute (NUL cannot be a shell word). */
export const UNKNOWN_SHELL_WORD = "\0";

/** References retain trailing group redirections without rescanning its commands. */
export interface ShellInput { parent?: ShellInput; redirected?: true; empty?: true }
export function shellInputSource(input: ShellInput | undefined): "stream" | "empty" | "inherit" {
  for (let depth = 0; input !== undefined; depth++, input = input.parent) {
    if (input.empty) return "empty";
    if (input.redirected || depth >= 256) return "stream";
  }
  return "inherit";
}

/** Bounded static syntax facts, never an interpreter and never alias/profile loading. */
export function shellSyntax(line: string, dialect: ShellDialect, depth = 0, inheritedInput?: ShellInput): { segments: string[][]; inputs: ShellInput[]; unreadable: boolean; persistentInput?: boolean } {
  if (line.length > 128 * 1024 || depth >= 8) return { segments: [], inputs: [], unreadable: true };
  const lifted = dialect === "posix" ? liftSubstitutions(line, true, false, true) : { outer: line, inner: [] };
  const tokens = lifted === null ? null : lexShellLine(lifted.outer, dialect, undefined, true, false, true);
  if (tokens === null || tokens.length > 16_384) return { segments: [line.slice(0, 4096).split(/\s+/).slice(0, 256)], inputs: [{ redirected: true }], unreadable: true };
  let unreadable = tokens.some((token, index) => token.kind === "open" && tokens[index - 1]?.kind === "word" && tokens[index + 1]?.kind === "close" && tokens[index + 2]?.kind === "word" && (tokens[index + 2] as { text?: string }).text === "{");
  const segments: string[][] = [];
  const inputs: ShellInput[] = [];
  type Frame = { kind: string; base: ShellInput; current: ShellInput; fds: Map<number, ShellInput>; local: Map<number, ShellInput>; piped: boolean; persisted?: boolean };
  const root: ShellInput = { parent: inheritedInput };
  const substitutionInputs: Array<ShellInput | undefined> = [];
  const placements = lifted?.placements ?? [];
  let placementIndex = 0;
  const frames: Frame[] = [{ kind: "root", base: root, current: { parent: root }, fds: new Map([[0, root]]), local: new Map([[0, root]]), piped: false }];
  const frame = () => frames[frames.length - 1]!;
  const open = (kind: string) => {
    const base = frame().current;
    const fds = new Map(frame().local); fds.set(0, base);
    frames.push({ kind, base, current: { parent: base }, fds, local: new Map(fds), piped: false });
  };
  const close = (kind: string) => {
    if (frames.length > 1 && frame().kind === kind) {
      // Conditional/brace execution and restoration cannot prove a later fd.
      if (kind !== "paren" && frame().persisted) unreadable = true;
      frames.pop();
    } else if (!(kind === "paren" && frame().kind === "case")) unreadable = true;
  };
  let words: string[] = [], redirected = false;
  let redirectToken: Extract<ShellToken, { kind: "redirect" }> | undefined;
  let commandPosition = true, pendingPipe = false;
  const flush = (persist = true) => {
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
    let exec = command;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(exec[0] ?? "")) exec = exec.slice(1);
    if (["command", "builtin"].includes(exec[0] ?? "")) {
      exec = exec.slice(1);
      if (exec[0] === "--" || exec[0] === "-p") exec = exec.slice(1);
    }
    if (exec[0] === "exec" && exec[1]?.startsWith("-")) unreadable = true;
    if (exec[0] === "exec" && exec.length === 1) {
      if (!persist || frame().piped) unreadable = true;
      else { frame().fds = new Map(frame().local); frame().persisted = true; }
    }
  };
  for (const token of tokens) {
    if (token.kind === "word" && token.span) {
      while (placementIndex < placements.length && placements[placementIndex]!.start < token.span[1]) {
        const placement = placements[placementIndex++]!;
        if (placement.start >= token.span[0]) substitutionInputs[placement.index] = placement.process === "out" ? { redirected: true } : frame().current;
      }
    }
    if (token.kind === "separator" && token.newline && pendingPipe) continue;
    if (token.kind === "separator" && pendingPipe) unreadable = true;
    if (token.kind === "redirect") {
      redirectToken = token;
      redirected = true; continue;
    }
    if (token.kind !== "word") {
      redirected = false; flush(token.kind !== "separator" || !token.pipe);
      if (token.kind === "open") open("paren");
      else if (token.kind === "close") close("paren");
      else {
        frame().piped = token.pipe === true;
        frame().local = new Map(frame().fds);
        frame().current = token.pipe ? { redirected: true } : { parent: frame().fds.get(0) ?? frame().base };
        frame().local.set(0, { ...frame().current });
      }
      commandPosition = true;
      pendingPipe = token.kind === "separator" && token.pipe === true;
      continue;
    }
    if (redirected) {
      const op = redirectToken!;
      const source = /^(?:<&|>&)$/.test(op.operator ?? "") && /^\d+$/.test(token.text) && !token.dynamic
        ? frame().local.get(Number(token.text)) ?? { redirected: true as const }
        : op.operator === "<" && !token.dynamic && posix.normalize(token.text) === "/dev/null" ? { empty: true as const } : { redirected: true as const };
      const fd = op.fd ?? op.inputFd;
      if (fd !== undefined) frame().local.set(fd, source);
      if (fd === 0) { frame().current.parent = source; delete frame().current.redirected; }
      redirected = false; continue;
    }
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
  for (const [index, inner] of (lifted?.inner ?? []).entries()) {
    // A lifted body without an owning word (for example heredoc text) is
    // unproven, rather than evidence that its process receives no input.
    if (substitutionInputs[index] === undefined) unreadable = true;
    const nested = shellSyntax(inner, dialect, depth + 1, substitutionInputs[index]);
    segments.push(...nested.segments); inputs.push(...nested.inputs); unreadable ||= nested.unreadable;
  }
  return { segments, inputs, unreadable, ...(frames[0]!.persisted ? { persistentInput: true } : {}) };
}
