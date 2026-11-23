# MCP client and tool catalog

Status: current
Owner: src/mcp/

This area owns mcp client and tool catalog. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [mcp-client.ts](mcp-client.ts)
- [mcp-manager.ts](mcp-manager.ts)
- [mcp-resource-class.ts](mcp-resource-class.ts)
- [mcp-sampling-handler.ts](mcp-sampling-handler.ts)
- [mcp-catalog.ts](mcp-catalog.ts) and [mcp-catalog-data.ts](mcp-catalog-data.ts): the built-in server catalog the add flows pick from
- [mcp-elicitation-handler.ts](mcp-elicitation-handler.ts)
- [mcp-oauth-flow.ts](mcp-oauth-flow.ts): browser sign-in for remote servers, see docs/client.md

## Ownership and dependencies

McpManager owns configured connections, discovery catalogs and dynamic tool registration; McpClient owns SDK transports and sampling and elicitation integration; elicitation reaches a person only through a host-wired port (docs/client.md). Resource classification maps server trust into dispatch policy. [TUI MCP feature](../tui/mcp/README.md) renders manager state and calls [shared config commands](../config/mcp-server-commands.ts); runtime owns the manager lifetime. Stdio processes get only allowlisted service variables plus their configured `env`; see docs/client.md.

Cloud tool, resource and prompt text projections bypass presentation character caps. Tool responses retain structured content plus additional text and embedded resource text, suppressing only an exact JSON mirror. Binary blocks keep their existing textual markers. Local projection precedence and caps are unchanged; trust and approval gates apply in either mode. [Adapter tests](mcp-tool-adapter.test.ts) cover both projections.

## Server catalog

[mcp-catalog-data.ts](mcp-catalog-data.ts) lists known servers by shelf (Basics, Code & docs, Work apps, Web & growth). An entry is only a pasteable `mcpServers` shortcut plus the `<your ...>` values the user must fill in, each with a label and, for keys, where to get one. Picking an entry fills the add box; the normal `parseAddServerJson` + `persistMcpServer` path still does the write, and a submit that still holds a placeholder is refused. Add an entry only after checking its package name or URL and key variable against the official README; A server that signs in through the browser instead of taking a key carries `"auth": "oauth"` (url servers only); the add flows then point at `/mcp auth <id>` or the desktop row's Sign in. An entry's `server` carries `"local": true` only when the server works on local data and never reaches the network (today filesystem, git, time, memory, sequential thinking; see [folder egress constraints](#folder-egress-constraints)); servers that fetch, browse or call an API, and any we are unsure of, stay unmarked. The desktop keeps a copy in `desktop/renderer/mcp-catalog.js` on the desktop branch, and its test compares the two.

## Folder egress constraints

In a folder with an egress constraint (`projects.constraints[...].allowedEgress`, see [provider policy](../llm/docs/provider-policy.md)), every MCP server's tools are classed `mcp:<server>`, stdio included, since a stdio process can reach the network itself (issue #60). Only a stdio entry with `"local": true` (a strict boolean; rejected on url servers) counts as staying on this machine; `McpManager.localOf` reports it and anything else reads as not local. The refusal of an unmarked stdio server names both ways out: add `mcp:<server>` to that folder's `allowedEgress`, or set `"local": true` on the `mcp.servers` entry when the server never uses the network. Behaviour change: constrained folders that ran stdio servers without the flag are now refused; unconstrained folders see no change.

## Offline mode

While offline mode is on (ATO-1084), a `streamable_http` or `sse` server that is not on this machine is refused before connecting. A stdio server is a separate program and is not network-isolated. See [offline mode](../llm/docs/offline-network.md).

A dynamic MCP tool checks literal HTTP(S) URL argument values before forwarding them, including values in nested arguments. A whole string matching an HTTP(S) URL is treated as a possible destination even in a text field, so offline mode may refuse a call that would only save that URL. URL-prefixed prose with no URL-data finding is treated as text. The data heuristic also checks the normalized form of URL-like text, including a query with literal spaces. An ambiguous string that carries URL data is treated as potentially outbound in offline mode and does not receive a strict first-visit prompt. Offline refusal precedes approvals. The URL check uses origin-scoped HTTP write approval in addition to the tool's MCP approval policy. Requests and redirects the server makes after receiving the arguments run in the server.

## Task-specific reading

Read docs/client.md before lifecycle, trust, sampling, elicitation or dynamic schema changes; ../tui/AGENTS.md for MCP panel work.

## Validation

`npx vitest run src/mcp`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).

Approval: tools from an `approval_gated` server ask before every call. A tool's own `readOnlyHint: true` skips the prompt only on a stdio server the operator installed on this machine, and on a remote server only for tools the agent's own integrations name in `trustedReadOnlyTools` (today Composio's two discovery tools; this field is not read from `config.json`). Other remote HTTP / SSE tools ask like everything else, whatever they say about themselves (ATO-1178). stdio is not a promise that nothing leaves the machine: a stdio wrapper around a cloud API sends its arguments out too. "Allow in this chat" on the prompt silences the prompts of that one tool of that server (the request carries `grantKey` = its qualified name) for the rest of the session; the server's other tools and other servers' tools still ask (ATO-1473).

Per-server approval mode (ATO-1134): `mcp.servers[].approval` in `config.json` replaces the answer above for that server's tools ([mcp-approval-mode.ts](mcp-approval-mode.ts)). `ask`: the default `approval_gated` behaviour, also on a `pure_read` server. `ask_writes`: a tool whose discovery-time `readOnlyHint` is `true` runs unasked only on a stdio server; every other tool asks, and so does every tool of a remote HTTP / SSE server, including the agent's own `trustedReadOnlyTools` exceptions (ATO-1178). `auto`: no prompt. Absent: `trust` decides, as before. `trust` still decides batching. A call a mode lets through that the default would have asked about still goes to the gate when a saved deny or ask rule names it (`savedRuleOverridesScope`).
