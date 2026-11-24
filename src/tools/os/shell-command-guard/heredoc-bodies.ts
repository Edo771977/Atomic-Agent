import { shellExpressionEnd } from "./command-substitution.js";

/** Keep heredoc data out of the shell substitution scanner. The placeholder
 * survives extraction of a surrounding command substitution. */
export function maskHeredocBodies(line: string): { text: string; restore: (value: string) => string } {
  const bodies = new Map<string, string>();
  let prefix = "__atomic_heredoc_";
  while (line.includes(prefix)) prefix += "_";
  const pending: { delimiter: string; stripTabs: boolean }[] = [];
  const quotes: string[] = [];
  let quote = "";
  let text = "";
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    text += c;
    if (c === "\\" && quote !== "'") {
      text += line[++i] ?? "";
      continue;
    }
    if (quote === "'") {
      if (c === "'") quote = "";
      continue;
    }
    const expression = c === "$" || !quote && (c === "(" || c === "[")
      ? shellExpressionEnd(line, i) : -1;
    if (expression !== -1) {
      text += line.slice(i + 1, expression + 1);
      i = expression;
      continue;
    }
    if (c === "$" && line[i + 1] === "(") {
      text += line[++i];
      quotes.push(quote);
      quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      if (!quote) quote = c;
      else if (quote === c) quote = "";
      continue;
    }
    if (quote) continue;
    if (c === "(") quotes.push("");
    if (c === ")" && quotes.length) quote = quotes.pop()!;
    if (c === "#" && (i === 0 || /[\s;|&()]/.test(line[i - 1]!))) {
      const end = line.indexOf("\n", i);
      if (end === -1) { text += line.slice(i + 1); break; }
      text += line.slice(i + 1, end);
      i = end - 1;
      continue;
    }
    if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<" && line[i - 1] !== "<") {
      const header = /^<<(-?)[ \t]*((?:'[^'\n]*'|"[^"\n]*"|\\[^\n]|[^\s<>;|&()'"\\])+)/.exec(line.slice(i));
      if (header) {
        const delimiter = header[2]!.replace(/'([^']*)'|"([^"]*)"|\\(.)/g,
          (_part, single, double, escaped) => single ?? double ?? escaped);
        pending.push({ delimiter, stripTabs: header[1] === "-" });
        text += header[0].slice(1);
        i += header[0].length - 1;
      }
    }
    if (c !== "\n") continue;
    for (const { delimiter, stripTabs } of pending.splice(0)) {
      const start = i + 1;
      let cursor = start;
      while (cursor < line.length) {
        const end = line.indexOf("\n", cursor);
        const next = end === -1 ? line.length : end + 1;
        const row = line.slice(cursor, end === -1 ? next : end);
        const key = stripTabs ? row.replace(/^\t+/, "") : row;
        if (key.replace(/\r$/, "") === delimiter) {
          const marker = prefix + bodies.size + "__";
          bodies.set(marker, line.slice(start, cursor));
          text += marker + "\n" + line.slice(cursor, next);
          i = next - 1;
          break;
        }
        cursor = next;
      }
      // Leave an unterminated candidate intact for the substitution scanner.
      if (cursor >= line.length) break;
    }
  }
  return {
    text,
    restore: (value) => value.replace(new RegExp(prefix + "\\d+__\\n", "g"),
      (match) => bodies.get(match.slice(0, -1)) ?? match),
  };
}
