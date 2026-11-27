import { programName, NESTED_SHELL_PROGRAMS, scanNestedShellOptions } from "../shell-command-guard/command-segments.js";
import { posix } from "node:path";

export type ScriptOperand = { kind: "inline" | "file" | "stdin" | "none" | "unknown"; operand?: string; stdin?: true };

/** Linear selector scan; does not interpret replacement text or compile a regex. */
function sedExternalCommand(script: string): boolean {
  let i = 0;
  const delimited = (delimiter: string) => {
    while (i < script.length) {
      const char = script[i++];
      if (char === "\\") i++;
      else if (char === delimiter) return;
    }
  };
  while (i < script.length) {
    while (i < script.length && /[\s\d$,!;{}]/.test(script[i]!)) i++;
    if (script[i] === "/") { i++; delimited("/"); continue; }
    const command = script[i++];
    if (command === "e") return true;
    if (command === "s" && i < script.length) {
      const delimiter = script[i++]!;
      delimited(delimiter); delimited(delimiter);
      while (i < script.length && !/[;{}\n\s]/.test(script[i]!)) {
        const flag = script[i++];
        if (flag === "e") return true;
        if (flag === "w") break;
      }
    }
    while (i < script.length && !/[;{}\n]/.test(script[i]!)) { if (script[i] === "\\") i++; i++; }
    i++;
  }
  return false;
}

/** Distinguish logical OR/regex/string pipes from awk's external pipes. */
function awkExternalCommand(script: string): boolean {
  let i = 0, operand = true;
  const quoted = (delimiter: string): boolean => {
    while (i < script.length) {
      const char = script[i++];
      if (char === "\\") i++;
      else if (char === delimiter) return true;
    }
    return false;
  };
  while (i < script.length) {
    const char = script[i++]!;
    if (/\s/.test(char)) continue;
    if (char === "#") { while (i < script.length && script[i] !== "\n") i++; continue; }
    if (char === '"' || char === "/" && operand) {
      if (!quoted(char)) return true;
      operand = false; continue;
    }
    if (char === "|") { if (script[i] !== "|") return true; i++; operand = true; continue; }
    if (char === "@") return true;
    if (/[A-Za-z_]/.test(char)) {
      const start = i - 1;
      while (i < script.length && /[A-Za-z_0-9]/.test(script[i]!)) i++;
      const word = script.slice(start, i);
      if (word === "system" && /^\s*\(/.test(script.slice(i))) return true;
      operand = /^(?:print|printf|return|getline)$/.test(word); continue;
    }
    if (/[0-9.]/.test(char)) { operand = false; continue; }
    operand = !/[)\]]/.test(char);
  }
  return false;
}

/** Lexical cwd only; Windows absolute spellings must not become relative POSIX suffixes. */
export function resolveScriptCwd(cwd: string | undefined, workingDir = process.cwd()): string {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/^([A-Za-z]:\/)/, "/$1");
  return posix.resolve(normalize(workingDir), normalize(cwd ?? "."));
}

/** Descriptor identities cannot be inferred from a different stdin payload. */
export function scriptStream(operand: string | undefined, cwd = process.cwd()): "stdin" | "unknown" | null {
  if (operand === undefined) return null;
  if (operand.includes("\0")) return "unknown";
  if (operand === "-") return "stdin";
  const path = posix.resolve(resolveScriptCwd(undefined, cwd), operand);
  if (path === "/dev/stdin" || path === "/dev/fd/0" || /^\/proc\/(?:self|thread-self|\d+)\/(?:task\/(?:self|thread-self|\d+)\/)?fd\/0$/.test(path)) return "stdin";
  return /^\/(?:dev|proc)(?:\/|$)/.test(path) ? "unknown" : null;
}

export function scriptInput(words: readonly string[], cwd = process.cwd()): "stdin" | "unknown" | null {
  const name = programName(words[0] ?? ""), args = words.slice(1);
  if (NESTED_SHELL_PROGRAMS.includes(name)) {
    const options = scanNestedShellOptions(args, name);
    if (options.readsStdin) return "stdin";
    if (options.runsCommand) return null;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--") return scriptStream(args[i + 1], cwd);
      if (/^(?:--rcfile|--init-file|[-+][A-Za-z]*[oO])$/.test(arg)) { i++; continue; }
      if (arg.startsWith("-") || arg.startsWith("+")) continue;
      return scriptStream(arg, cwd);
    }
    return null;
  }
  const script = interpreterScript(words, cwd);
  return script?.stdin === true || script?.kind === "stdin" ? "stdin" : script?.kind === "file" ? scriptStream(script.operand, cwd) : null;
}

/** Static option boundaries only: never inspect or execute a program's code. */
export function interpreterScript(words: readonly string[], cwd = process.cwd()): ScriptOperand | null {
  const name = programName(words[0] ?? "");
  const args = words.slice(1);
  if (/^(?:source|\.)$/.test(name)) return { kind: args[0] ? "file" : "unknown", operand: args[0] };
  const python = /^python\d*(?:\.\d+)?$/.test(name);
  if (!python && !/^(?:node|perl|ruby|php|osascript|g?awk|sed)$/.test(name)) return null;
  if (/^(?:g?awk|sed)$/.test(name)) {
    const scripts: string[] = [];
    let file: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--") { if (scripts.length === 0 && file === undefined) scripts.push(args[++i] ?? ""); break; }
      if (/^(?:-f|--file)$/.test(arg)) { file = args[++i]; continue; }
      if (/^(?:-f.|--file=)/.test(arg)) { file = arg.replace(/^(?:-f|--file=)/, ""); continue; }
      if (/^(?:-e|--expression|--source)$/.test(arg)) { scripts.push(args[++i] ?? ""); continue; }
      if (/^(?:-e.|--expression=|--source=)/.test(arg)) { scripts.push(arg.replace(/^(?:-e|--expression=|--source=)/, "")); continue; }
      if (/^(?:-v|--assign|-F|--field-separator)$/.test(arg) && name !== "sed") { i++; continue; }
      if (arg.startsWith("-")) continue;
      if (scripts.length === 0 && file === undefined) scripts.push(arg);
      continue;
    }
    // External-command extensions are not the ordinary text-processing DSL.
    const opaque = scripts.some(script => name === "sed" ? sedExternalCommand(script) : awkExternalCommand(script));
    return opaque ? { kind: "inline" } : file !== undefined ? { kind: "file", operand: file } : { kind: "none" };
  }
  let nodeInputType = false;
  let nodeCodeLoad = false;
  const selected = (operand: string | undefined): ScriptOperand => {
    const stdin = operand === undefined || scriptStream(operand, cwd) === "stdin";
    if (name === "node" && (nodeCodeLoad || nodeInputType && stdin)) return { kind: "inline", ...(stdin ? { stdin: true } : {}) };
    return operand === undefined ? { kind: "stdin" } : { kind: operand === "-" ? "stdin" : "file", operand };
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return selected(args[i + 1]);
    if (arg === "-" || !arg.startsWith("-")) return selected(arg);
    if (python) {
      if (/^-c/.test(arg)) return { kind: "inline" };
      if (/^-m/.test(arg)) return { kind: "file", operand: arg.length > 2 ? arg.slice(2) : args[i + 1] };
      if (["-W", "-X", "--check-hash-based-pycs"].includes(arg)) { i++; continue; }
      if (/^-(?:W|X).|^--check-hash-based-pycs=/.test(arg)) continue;
      if (/^--(?:help(?:-env|-xoptions|-all)?|version)$|^-[hV]$/.test(arg)) return { kind: "none" };
      if (!/^-[bBdEhiIOPqRsSuvVx]+$/.test(arg)) return { kind: "unknown" };
    } else if (name === "node") {
      if (/^-(?:e|p)(?:.|$)|^--(?:eval|print)(?:=|$)/.test(arg)) return { kind: "inline" };
      const shortRequire = /^-r./.test(arg);
      const option = shortRequire ? "-r" : arg.split("=", 1)[0]!;
      const value = shortRequire ? arg.slice(2) : arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[i + 1];
      const values = ["-r", "--require", "--import", "--input-type", "--loader", "--experimental-loader", "--conditions", "--inspect-port", "--title", "--icu-data-dir", "--openssl-config", "--redirect-warnings", "--report-directory", "--report-filename", "--diagnostic-dir", "--unhandled-rejections", "--test-name-pattern", "--test-skip-pattern", "--test-concurrency", "--test-reporter", "--test-reporter-destination", "--test-shard", "--test-timeout", "--max-old-space-size", "--stack-trace-limit", "--stack-size", "--stack_size", "--env-file", "--env-file-if-exists", "--watch-path", "--disable-warning", "--dns-result-order", "--localstorage-file"];
      if (["-r", "--require", "--import", "--loader", "--experimental-loader"].includes(option) && /^data:/i.test(value?.trimStart() ?? "")) nodeCodeLoad = true;
      if (values.includes(option) || /^--allow-fs-/.test(option)) {
        if (value === undefined) return { kind: "unknown" };
        nodeInputType ||= option === "--input-type";
        if (!arg.includes("=") && !shortRequire) i++;
        continue;
      }
      if (/^(?:-v|--version|--help)$/.test(arg)) return { kind: "none" };
      if (!/^(?:-c|--check|--test|--watch|--trace-warnings|--trace-deprecation|--no-warnings|--enable-source-maps|--use-strict|--pending-deprecation|--expose-gc|--no-deprecation|--trace-uncaught|--abort-on-uncaught-exception|--(?:no-)?experimental-strip-types|--experimental-vm-modules|--preserve-symlinks(?:-main)?|--test-only|--(?:experimental-)?permission|--(?:no-)?experimental-require-module|--no-addons|--inspect(?:-brk)?(?:=.*)?)$/.test(arg)) return { kind: "unknown" };
    } else if (name === "perl" || name === "ruby") {
      if (arg.startsWith("--")) {
        if (name === "ruby" && ["--encoding", "--external-encoding", "--internal-encoding"].includes(arg.split("=", 1)[0]!)) { if (!arg.includes("=")) i++; continue; }
        if (/^--(?:version|help)$/.test(arg)) return { kind: "none" };
        return { kind: "unknown" };
      }
      const valueFlags = name === "perl" ? "IMmFi" : "IrCFEKTW";
      for (let j = 1; j < arg.length && arg[1] !== "-"; j++) {
        const flag = arg[j]!;
        if (flag === "e" || name === "perl" && flag === "E") return { kind: "inline" };
        if (valueFlags.includes(flag)) { if (j === arg.length - 1) i++; break; }
      }
    } else if (name === "php") {
      if (/^-[rBRE]/.test(arg)) return { kind: "inline" };
      if (arg === "-f") return { kind: "file", operand: args[i + 1] };
      if (/^(?:-d|-c)$/.test(arg)) i++;
    } else if (name === "osascript") {
      if (arg === "-e") return { kind: "inline" };
      if (arg === "-l" || arg === "-s") i++;
    }
  }
  return selected(undefined);
}
