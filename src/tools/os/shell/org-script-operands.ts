import { programName } from "../shell-command-guard/command-segments.js";

export type ScriptOperand = { kind: "inline" | "file" | "stdin" | "none" | "unknown"; operand?: string };

/** Static option boundaries only: never inspect or execute a program's code. */
export function interpreterScript(words: readonly string[]): ScriptOperand | null {
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
      if (/^(?:-e|--expression)$/.test(arg)) { scripts.push(args[++i] ?? ""); continue; }
      if (/^(?:-e.|--expression=)/.test(arg)) { scripts.push(arg.replace(/^(?:-e|--expression=)/, "")); continue; }
      if (/^(?:-v|--assign|-F|--field-separator)$/.test(arg) && name !== "sed") { i++; continue; }
      if (arg.startsWith("-")) continue;
      if (scripts.length === 0 && file === undefined) scripts.push(arg);
      break;
    }
    if (file !== undefined) return { kind: "file", operand: file };
    // External-command extensions are not the ordinary text-processing DSL.
    const opaque = scripts.some(script => name === "sed" ? /(?:^|[;\n])\s*e(?:\s|$)|s(.).*\1.*\1[^;\n]*e/.test(script) : /\bsystem\s*\(|\|/.test(script));
    return { kind: opaque ? "inline" : "none" };
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return args[i + 1] === undefined ? { kind: "stdin" } : { kind: "file", operand: args[i + 1] };
    if (arg === "-" || !arg.startsWith("-")) return { kind: arg === "-" ? "stdin" : "file", operand: arg };
    if (python) {
      if (/^-c/.test(arg)) return { kind: "inline" };
      if (/^-m/.test(arg)) return { kind: "file", operand: arg.length > 2 ? arg.slice(2) : args[i + 1] };
      if (arg === "-W" || arg === "-X") i++;
    } else if (name === "node") {
      if (/^-(?:e|p)(?:.|$)|^--(?:eval|print)(?:=|$)/.test(arg)) return { kind: "inline" };
      if (/^(?:-r|--require|--import|--input-type|--loader|--experimental-loader|--conditions|--inspect-port)$/.test(arg)) i++;
    } else if (name === "perl" || name === "ruby") {
      if (/^-[^-]*[eE]/.test(arg)) return { kind: "inline" };
      if (/^(?:-I|-M|-m|-r|-C|-F)$/.test(arg)) i++;
    } else if (name === "php") {
      if (/^-r/.test(arg)) return { kind: "inline" };
      if (arg === "-f") return { kind: "file", operand: args[i + 1] };
      if (/^(?:-d|-c)$/.test(arg)) i++;
    } else if (name === "osascript") {
      if (arg === "-e") return { kind: "inline" };
      if (arg === "-l" || arg === "-s") i++;
    }
  }
  return { kind: "stdin" };
}
