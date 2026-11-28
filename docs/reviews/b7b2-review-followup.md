# B7b2 review corrections

Status: current
Owner: docs/reviews/

PR #296, existing branch `codex/b7b2-tool-names`. Main `54f81900b` was merged first. The adjacent triage conflict keeps all main rows and restores only this PR's #1724 row. The [initial review](b7b2-tool-names.md) and reports retain the original import history; the rules below supersede unrestricted MCP separator folding.

## 1. Preserve the MCP server boundary

Resolution requires literal dotted or double-underscore structural boundaries around a server whose spelling matches a registered server (case-insensitive only). An absent or ambiguous server is refused before considering tools. Raw-tool underscore/hyphen variants are then compared only within that server; dots in the raw tool remain structural. An escaped wire form may have both literal-underscore and decoded-dot interpretations; if they match multiple tools, neither is chosen.

With only `mcp.brave.search.web_search`, all three review negatives return null and the exact name works. With both `brave` and `brave-search` represented in the catalog, `mcp.brave-search.web-search` selects `web_search` only from `brave-search`, in either registration order. Case-colliding servers, mixed structural separators and ambiguous tools remain refused.

[Resolver tests](../../src/agent/tool-name-resolution.test.ts) and the [dispatch boundary suite](../../src/agent/tool-name-policy-boundary.test.ts) first recorded 32 passed / 9 failed; all 41 then passed after the correction. Existing ambiguity assertions now use two ambiguous tools within one server rather than conflating two distinct servers. The real approval, policy, filter, read/input, cancellation and stable-prefix controls are retained. No MCP connection, descriptor, trust mode or report changes. [Red/green evidence](b7b2-review-mcp.json).

## 2. ASCII-only resolution before trim

The optional conservative choice is to refuse non-ASCII resolver input, before even the exact lookup. This avoids Unicode aliases rather than adding compatibility normalization. Five cases were red first: Kelvin folding, three BOM placements (including within quotes) and exact non-ASCII lookup. After the guard all 46 resolver/dispatch tests pass. [Red/green evidence](b7b2-review-ascii.json).
