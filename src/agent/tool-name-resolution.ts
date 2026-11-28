import type { ToolRegistry } from "../tools/tool-registry.js";

/**
 * Resolve a tool name the model emitted to one the registry holds.
 *
 * Qualified names carry dots — `fusion.delegate`, `os.fs.write` — and
 * the OpenAI wire format forbids them, so they travel as `__` and come
 * back through `nameUnescape`. A model that writes the escaped form
 * from memory rather than copying it gets the separator wrong, and the
 * near miss is not a typo in the usual sense: every character of the
 * name is right.
 *
 * That cost a real session its entire turn. The model emitted
 * `fusion_delegate`, one underscore short of the escape, twice; the
 * membership check in the step executor throws for the whole batch, so
 * a 30-minute turn ended with `reason=failed` over a separator.
 *
 * The candidates are deliberately narrow — separator confusion, case,
 * and wrapping the model or its chat template added. This is not fuzzy
 * matching: `os.fs.write` must never resolve to `os.fs.trash` because
 * the two are close. Every character of the tool's own name must be
 * there, in order; only separators, case and wrapping may differ, and
 * the form must point at exactly one registered tool. Anything else is
 * still unknown and gets the error result naming the closest tools
 * (`policies/unknown-tool.ts`).
 */
export function resolveToolName(
  name: string,
  registry: Pick<ToolRegistry, "has" | "list">,
): string | null {
  if (registry.has(name)) return name;

  // Every nonexact spelling must consider the complete catalog. A fast
  // separator/case match could otherwise choose the first of two MCP
  // names with the same shape and evade the ambiguity check below.
  return resolveByShape(name, registry.list().map((definition) => definition.name));
}

const FUNCTIONS_PREFIX = "functions.";

/**
 * The name with what is not part of it taken off: a chat-template tail
 * (`os.fs.read<|channel|>commentary`, gpt-oss), surrounding quotes or
 * backticks, an empty call `()` and trailing punctuation.
 */
function stripWrapping(name: string): string {
  let value = name.replace(/<\|[\s\S]*$/, "").trim();
  // Handle both `"tool"()` and `"tool()"` without accepting arguments.
  for (let pass = 0; pass < 2; pass++) {
    value = value.replace(/[:;,.!?]+$/, "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/\(\s*\)$/, "").trim();
  }
  return value;
}

/**
 * Built-in separator/case spelling. MCP server and raw-tool boundaries
 * use the separate, stricter comparison below.
 */
function shapeKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[._-]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

/** The one element of `matches`, or `null` when there are none or several. */
function only(matches: ReadonlySet<string>): string | null {
  return matches.size === 1 ? [...matches][0]! : null;
}

/**
 * The forms an emitted name is compared under: as written, and without
 * the `functions.` namespace OpenAI-style templates put in front of
 * every function (`functions.os.fs.read`, `functions__os__fs__read`).
 */
function emittedKeys(name: string): string[] {
  const key = shapeKey(stripWrapping(name));
  if (key.length === 0) return [];
  return key.startsWith(FUNCTIONS_PREFIX) && key.length > FUNCTIONS_PREFIX.length
    ? [key, key.slice(FUNCTIONS_PREFIX.length)]
    : [key];
}

/**
 * The whole name in another spelling of exactly one registered tool:
 * separators and case for built-ins; MCP names first keep an explicit,
 * registered server identity and then compare only its raw tools.
 * Wrapping (`"os.fs.read"`,
 * `os.fs.read()`) and the `functions.` namespace. Two raw tools that
 * share a spelling within one MCP server resolve to neither.
 *
 * A name with part of the real one missing is not resolved, however
 * likely the match: `write_file` may be meant for `os.fs.write` or an
 * MCP filesystem server's `write_file`, `github.create_issue` for the
 * built-in GitHub tool or an MCP server's. Those get the error result
 * naming the candidates, and the model picks (ATO-1674).
 */
function resolveByShape(name: string, registered: readonly string[]): string | null {
  const keys = emittedKeys(name);
  if (keys.length === 0) return null;
  const matches = mcpMatches(stripWrapping(name), registered);
  for (const candidate of registered) {
    if (/^mcp\./i.test(candidate)) continue;
    if (keys.includes(shapeKey(candidate))) matches.add(candidate);
  }
  return only(matches);
}

/** MCP dots remain structural; only underscores/hyphens within a tool segment vary. */
function mcpToolKey(raw: string): string {
  return raw.toLowerCase().replace(/[_-]+/g, "_");
}

function mcpMatches(name: string, registered: readonly string[]): Set<string> {
  const catalog = registered.flatMap(qualified => {
    const parts = /^mcp\.([^.]+)\.(.+)$/i.exec(qualified);
    return parts ? [{ qualified, server: parts[1]!, raw: parts[2]! }] : [];
  });
  const forms = [name];
  const wrapper = /^functions(?:\.|__)/i.exec(name);
  if (wrapper) forms.push(name.slice(wrapper[0].length));
  const routes: { server: string; raw: string; escaped: boolean }[] = [];
  for (const server of new Set(catalog.map(tool => tool.server))) {
    for (const form of forms) {
      for (const separator of [".", "__"]) {
        const prefix = `mcp${separator}${server}${separator}`;
        if (form.toLowerCase().startsWith(prefix.toLowerCase()) && form.length > prefix.length) {
          routes.push({ server, raw: form.slice(prefix.length), escaped: separator === "__" });
        }
      }
    }
  }
  // No separator folding, prefix guessing or first/longest-server choice.
  // Even a unique raw tool cannot disambiguate two server identities.
  if (new Set(routes.map(route => route.server)).size !== 1) return new Set();
  const keys = new Set(routes.flatMap(route => [
    mcpToolKey(route.raw),
    // Preserve wire dots without choosing over a literal double underscore.
    ...(route.escaped ? [mcpToolKey(route.raw.replaceAll("__", "."))] : []),
  ]));
  return new Set(catalog.filter(tool => tool.server === routes[0]!.server && keys.has(mcpToolKey(tool.raw)))
    .map(tool => tool.qualified));
}
