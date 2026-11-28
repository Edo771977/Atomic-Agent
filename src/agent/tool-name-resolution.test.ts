import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../tools/tool-registry.js";
import { resolveToolName } from "./tool-name-resolution.js";
import { closestToolNames, unknownToolResult } from "./policies/unknown-tool.js";

function registry(...names: string[]): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of names) {
    reg.register({
      name,
      description: name,
      readonly: true,
      run: async () => ({
        tool: name,
        status: "ok" as const,
        summary: "",
        details: {},
        truncated: false,
      }),
    });
  }
  return reg;
}

const REG = registry(
  "fusion.delegate",
  "os.fs.write",
  "os.fs.trash",
  "reply",
);

describe("resolveToolName", () => {
  it("refuses the non-ASCII Kelvin sign before lowercasing it to an ASCII k", () => {
    expect(resolveToolName("os.fs.\u212Aey", registry("os.fs.key"))).toBeNull();
  });
  it.each(["\uFEFFos.fs.write", "os.fs.write\uFEFF", '"\uFEFFos.fs.write"'])("refuses a BOM before trimming or unwrapping %s", name => {
    expect(resolveToolName(name, REG)).toBeNull();
  });
  it("refuses a non-ASCII name even before the exact-name fast path", () => {
    expect(resolveToolName("mcp.brave.\u212Aey", registry("mcp.brave.\u212Aey"))).toBeNull();
  });
  it.each([["os.fs.key", "os.fs.\u212Aey"], ["mcp.brave.key", "mcp.brave.\u212Aey"]])("does not fold a registered non-ASCII %s candidate back into an ASCII alias", (emitted, registered) => {
    expect(resolveToolName(emitted, registry(registered))).toBeNull();
  });
  it("returns an exact name untouched", () => {
    expect(resolveToolName("os.fs.write", REG)).toBe("os.fs.write");
    expect(resolveToolName("reply", REG)).toBe("reply");
  });

  it("fixes the separator a model got one underscore short", () => {
    // The observed failure: `fusion.delegate` travels the OpenAI wire as
    // `fusion__delegate`, the model wrote it from memory as
    // `fusion_delegate`, and the turn died on the membership check.
    expect(resolveToolName("fusion_delegate", REG)).toBe("fusion.delegate");
    expect(resolveToolName("os_fs_write", REG)).toBe("os.fs.write");
  });

  it("resolves a name that arrived still escaped", () => {
    // The text-JSON fallback path does not run `nameUnescape`.
    expect(resolveToolName("fusion__delegate", REG)).toBe("fusion.delegate");
  });

  it("resolves case on its own and over a fixed separator", () => {
    expect(resolveToolName("OS.FS.WRITE", REG)).toBe("os.fs.write");
    expect(resolveToolName("Fusion_Delegate", REG)).toBe("fusion.delegate");
  });

  it("refuses to guess between near neighbours", () => {
    // Not fuzzy matching. `os.fs.write` must never resolve to
    // `os.fs.trash` because the two are close — a tool that deletes is
    // one edit away from a tool that writes.
    expect(resolveToolName("os.fs.writ", REG)).toBeNull();
    expect(resolveToolName("os.fs.wrote", REG)).toBeNull();
    expect(resolveToolName("fs.write", REG)).toBeNull();
  });

  it("returns null for a name that is nothing like a registered tool", () => {
    expect(resolveToolName("summon_daemon", REG)).toBeNull();
    expect(resolveToolName("", REG)).toBeNull();
  });
});

// ATO-1674: near misses on MCP tools (added in v0.7/v0.8) and on the
// wrapping a model or its chat template puts around a name.
const MCP_REG = registry(
  "os.fs.read",
  "os.fs.write",
  "os.web.search",
  "mcp.resource.list",
  "mcp.github.create_issue",
  "mcp.github.list_issues",
  "mcp.brave-search.brave_web_search",
  "mcp.search.web_search",
);

describe("resolveToolName on separator and wrapping forms", () => {
  it("refuses flattened MCP names without explicit server boundaries", () => {
    expect(resolveToolName("mcp_github_create_issue", MCP_REG)).toBeNull();
  });

  it("requires the registered server spelling before normalizing its tool", () => {
    expect(resolveToolName("mcp__brave-search__brave_web_search", MCP_REG)).toBe(
      "mcp.brave-search.brave_web_search",
    );
    expect(resolveToolName("mcp.brave-search.brave-web-search", MCP_REG)).toBe(
      "mcp.brave-search.brave_web_search",
    );
    expect(resolveToolName("mcp__brave_search__brave_web_search", MCP_REG)).toBeNull();
    expect(resolveToolName("mcp.brave_search.brave-web-search", MCP_REG)).toBeNull();
  });

  it("drops the `functions.` namespace of OpenAI-style templates", () => {
    expect(resolveToolName("functions.os.fs.read", MCP_REG)).toBe("os.fs.read");
    expect(resolveToolName("functions__mcp__github__list_issues", MCP_REG)).toBe("mcp.github.list_issues");
  });

  it("drops quotes, an empty call, trailing punctuation and a chat-template tail", () => {
    expect(resolveToolName("`os.fs.read`", MCP_REG)).toBe("os.fs.read");
    expect(resolveToolName('"os.fs.read"', MCP_REG)).toBe("os.fs.read");
    expect(resolveToolName("os.fs.read()", MCP_REG)).toBe("os.fs.read");
    expect(resolveToolName("os.fs.read:", MCP_REG)).toBe("os.fs.read");
    expect(resolveToolName("os.fs.read<|channel|>commentary", MCP_REG)).toBe("os.fs.read");
  });
});

describe("resolveToolName preserves MCP server boundaries", () => {
  const onlyBrave = registry("mcp.brave.search.web_search");
  it.each(["mcp.brave-search.web_search", "mcp_brave_search_web_search", "mcp.brave.search-web-search"])("refuses %s when only brave's dotted raw tool exists", name => {
    expect(resolveToolName(name, onlyBrave)).toBeNull();
  });
  it("keeps an exact MCP name and only normalizes within its dotted tool segments", () => {
    expect(resolveToolName("mcp.brave.search.web_search", onlyBrave)).toBe("mcp.brave.search.web_search");
    expect(resolveToolName("MCP.BRAVE.SEARCH.WEB-SEARCH", onlyBrave)).toBe("mcp.brave.search.web_search");
  });
  it.each([false, true])("chooses the explicitly named registered server in either catalog order (%s)", reverse => {
    const names = ["mcp.brave.search.web_search", "mcp.brave-search.web_search"];
    const reg = registry(...(reverse ? names.reverse() : names));
    expect(resolveToolName("mcp.brave-search.web-search", reg)).toBe("mcp.brave-search.web_search");
    expect(resolveToolName("mcp__brave-search__web-search", reg)).toBe("mcp.brave-search.web_search");
    expect(resolveToolName("functions.MCP.BRAVE.SEARCH.WEB-SEARCH", reg)).toBe("mcp.brave.search.web_search");
  });
  it("refuses an ambiguous case-insensitive server even if only one tool matches", () => {
    const reg = registry("mcp.Brave.web_search", "mcp.brave.other_tool");
    expect(resolveToolName("MCP.BRAVE.WEB-SEARCH", reg)).toBeNull();
    expect(resolveToolName("mcp.Brave.web_search", reg)).toBe("mcp.Brave.web_search");
  });
  it("refuses ambiguous tool shapes within the identified server", () => {
    const reg = registry("mcp.brave.web_search", "mcp.brave.web-search");
    expect(resolveToolName("functions.mcp.brave.web__search", reg)).toBeNull();
  });
  it("refuses mixed structural separators beside the server", () => {
    const reg = registry("mcp.brave.web_search");
    expect(resolveToolName("mcp.brave__web-search", reg)).toBeNull();
    expect(resolveToolName("mcp__brave.web-search", reg)).toBeNull();
  });
});

describe("resolveToolName with part of the real name missing", () => {
  // Never resolved, however likely the match: the short form can be
  // meant for a different tool, and a different tool can act outside
  // the read roots or without approval. The error result names the
  // candidates and the model picks (ATO-1674).
  const SHORT_REG = registry(
    "os.fs.read",
    "os.fs.write",
    "github.issue.create",
    "mcp.github.create_issue",
    "mcp.filesystem.write_file",
    "mcp.filesystem.delete_file",
    "mcp.composio.GITHUB_CREATE_ISSUE",
  );
  const names = SHORT_REG.list().map((definition) => definition.name);

  it.each([
    ["write_file", ["mcp.filesystem.write_file", "os.fs.write"]],
    ["delete_file", ["mcp.filesystem.delete_file"]],
    ["github.create_issue", ["mcp.github.create_issue", "github.issue.create"]],
    ["create_issue", ["mcp.github.create_issue"]],
    ["mcp.create_issue", ["mcp.github.create_issue"]],
  ] as const)("%s is not resolved and the error result names the candidates", (emitted, named) => {
    expect(resolveToolName(emitted, SHORT_REG)).toBeNull();
    const suggestions = closestToolNames(emitted, names);
    for (const candidate of named) expect(suggestions).toContain(candidate);
    const refused = unknownToolResult(emitted, names);
    expect(refused).toMatchObject({ tool: emitted, status: "error" });
    expect(refused.details).toMatchObject({ unregisteredTool: true });
    for (const candidate of named) expect(refused.details?.suggestions).toContain(candidate);
  });

  it("does not resolve a namespace-less Composio name either", () => {
    expect(resolveToolName("GITHUB_CREATE_ISSUE", SHORT_REG)).toBeNull();
  });

  it("refuses two tools that share one spelling", () => {
    const collide = registry("mcp.a.b_c", "mcp.a_b.c");
    expect(resolveToolName("mcp_a_b_c", collide)).toBeNull();
    expect(resolveToolName("mcp-a-b-c", collide)).toBeNull();
    // Each exact name still resolves to itself.
    expect(resolveToolName("mcp.a.b_c", collide)).toBe("mcp.a.b_c");
    expect(resolveToolName("mcp.a_b.c", collide)).toBe("mcp.a_b.c");
  });

  it("still refuses a name that is a different tool, not a different spelling", () => {
    expect(resolveToolName("mcp.github.create_issues", MCP_REG)).toBeNull();
    expect(resolveToolName("mcp.github.close_issue", MCP_REG)).toBeNull();
    expect(resolveToolName("os.fs.writ", MCP_REG)).toBeNull();
    expect(resolveToolName("functions.", MCP_REG)).toBeNull();
    expect(resolveToolName("()", MCP_REG)).toBeNull();
  });
});
