# Organization policy

Status: current
Owner: src/policy/

Rules an administrator sets for every agent on a machine (ATO-587): which shell commands, file writes, web requests, skills and MCP servers are allowed, need a person's yes, or are blocked. The user cannot loosen them from the agent.

## Where the policy comes from

Read at start. No source can loosen another: each one is evaluated on its own and the strictest answer across them wins. A source the user can write (their own file, `ATOMIC_POLICY_URL`, the cache) can only add `ask`, `deny` and allowlist limits; it can never cancel the machine-wide file's `ask` or widen its MCP allowlist.

1. `<stateDir>/policy.json` (usually `~/.atomic-agent/policy.json`).
2. The machine-wide file: macOS `/Library/Application Support/AtomicAgent/policy.json`, Linux `/etc/atomic-agent/policy.json`, Windows `%ProgramData%\AtomicAgent\policy.json`.
3. A policy URL, fetched once at start with a 3 s timeout: the machine-wide file's `"url"` field if it has one (the user cannot unset it), else `ATOMIC_POLICY_URL`. A `url` in the user's own file is ignored. A good copy is cached in `<stateDir>/policy-cache.json`; when the fetch fails the cached copy for the same URL is used. A policy server that is down never stops the agent.

A missing optional local file is no policy. A malformed or unreadable local file refuses startup (and short-lived commands) with its source and reason. Unknown keys at the document, rule and allowlist levels are errors. An evaluator failure refuses the call. This fork tightens upstream's warning-only treatment of broken local files.

The upstream URL availability exception is retained explicitly: a failed fetch, invalid remote document or unusable cache falls back to the validated cached document for the same URL; without one, the source is reported as `unreachable`. Local file restrictions remain in force. Offline mode checks the destination before invoking the transport. Put mandatory restrictions in the machine-wide file rather than relying solely on a remote policy being reachable.

## Format

```json
{
  "version": 1,
  "rules": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "git status*", "effect": "allow" },
    { "action": "shell", "resource": "rm -rf *", "effect": "deny", "note": "ask IT" },
    { "action": "webfetch", "resource": "https://*.internal.example.com/*", "effect": "deny" },
    { "action": "skill", "resource": "publish-*", "effect": "deny" },
    { "action": "mcp", "resource": "github/delete_*", "effect": "deny" }
  ],
  "mcpAllowlist": { "servers": ["github", "https://mcp.example.com/*"], "warnOnly": false }
}
```

- `action`: `shell` (the command line and each command in it, read like saved deny rules: past `sudo` / `env` / `FOO=1`, inside `bash -c`, `eval` and `find -exec`, and each also with its program reduced to its name, so `/bin/rm -rf x` matches `rm *`; a script piped into a shell, `printf … | sh`, matches every shell `deny` and `ask`), `edit` (file paths written, moved or trashed), `webfetch` (URLs, as given and as the fetch reads them: scheme and host lowercased, no user info or default port, at least a `/` path; plus the origin and the host alone, so `https://evil.com`, `evil.com` or `*.evil.com` covers every URL on that host), `websearch` (the query), `skill` (skill name), `mcp` (`<server>/<tool>`).
- `resource`: glob; `*` is any run of characters including `/`, `?` one character. Default `*`.
- `effect`: inside one source the last matching rule wins, except that any matching `deny` wins wherever it sits. `allow` only cancels an earlier `ask` of the same source; it never cancels another source's `ask` and never skips a prompt the user's own settings would show.
- `mcpAllowlist.servers`: globs matched against a server's name, URL or stdio command line. With a list present, a server not on it stays down with the reason as its error. When several sources set a list, a server must be on each one. `warnOnly: true` logs it and lets it connect, for that list only. No list: every server may connect.
- `url` (machine-wide file only): the policy URL to fetch, see above.

## Where it is enforced

- Dispatch (`agent/dispatch/batch-gates.ts`, `refuseByOrgPolicy`) and direct registry invocation: a denied call is refused before hooks or tool execution. The registry retains the fork's independent egress and read boundaries.
- Approval gate (`ApprovalGate.setOrgPolicy`): a policy `deny` or `ask` acts like a saved rule of the user's, above them; `ask` prompts whatever the approval level or session grants say.
- Filesystem mutations outside home/workspace keep the fork's `other` approval category and still match `edit` policy, including Office writers and archive extraction.
- MCP (`McpManagerDeps.serverPolicy`): the allowlist, checked before every connect.
- `atag mcp-server` (`cli/mcp-server-command.ts`, `cli/mcp-server-bridge.ts`): loads and installs the policy itself, gives its gate `setOrgPolicy`, and refuses a denied call before it runs; a policy `ask` is refused there, since an MCP client cannot answer a prompt.
- Skills: `prepareSkillInstall` refuses a denied skill (`policy_denied`, HTTP 403); the registry and workspace discovery exclude it, and a previously selected workspace skill is checked again before use. A policy allow never activates an unconfirmed learned draft.
- Fusion and verification: workers share the dispatch/gate policy; worker candidate paths are also matched against the original project. Contract authorization and the actual rebased executor check shell denies (including stdin scripts) and explicit page/probe URLs. Detached shell jobs pass the same launch checks before becoming jobs. Fixed verification executors (including UI detectors) also check the command actually spawned. A host-retargeted file write is checked at its approved destination.

## Who manages the files

The operator edits the user policy outside agent tools. The system policy remains in the administrator-owned system location, separate from relocated user state. Its restrictions intersect with the user policy and URL/cache restrictions; moving user state cannot loosen the system file. Keep the system directory and file writable only by administrators.

The user policy, cache and system file are included in `getTrustConfigPaths` and `getStateSecretPaths`, alongside configuration and `serve-api.key`. They reach the same read-scope, shell secret scan and sandbox protection. Policy-file reads, replacement and deletion through agent tools are refused even at full trust; an approval card cannot override this refusal. The cache uses the configuration's owner-only atomic writer. `ATOMIC_AGENT_TOOL_CHILD` children (including MCP stdio servers) cannot inspect policy through `policy show` or load another policy context with a substituted state directory. There are no HTTP policy-management routes or config keys that disable policy; changing saved approval rules cannot cancel it.

These are application checks plus the existing optional OS sandbox, not isolation from arbitrary code running under the operator's OS account. Recognized shell paths receive the secret/state guard; computed paths have the same best-effort classifier limits as configuration and the serve key. Windows has no native command sandbox; requested Safe Mode refuses execution there. See [OS sandbox](../../docs/user/os-sandbox.md).

## Not done yet

`ask` only prompts where the tool already asks the gate: shell commands that need approval, file writes, HTTP requests, gated MCP tools. `os.web.search`, read-only MCP tools and shell commands the guard deems safe honour `deny` but are not prompted on `ask`. The policy is read once per start. No cloud publishing of skills or MCP servers per organization, no admin UI.

## Entry points

- [policy-schema.ts](policy-schema.ts): the file format and its parser.
- [policy-evaluator.ts](policy-evaluator.ts): rule order, strictest source wins, the MCP allowlists.
- [policy-loader.ts](policy-loader.ts): files, URL, cache.
- [policy-targets.ts](policy-targets.ts): a gate request or a tool call as action and resources.
- [policy-enforce.ts](policy-enforce.ts): answers for the gate, the dispatcher, skills and MCP.
- [policy-active.ts](policy-active.ts): the policy installed at boot.

## Validation

`npx vitest run src/policy src/approval/approval-gate-org-policy.test.ts src/agent/dispatch/batch-gates.test.ts src/mcp/mcp-manager.test.ts src/skills/skill-installer.test.ts src/cli/policy-command.test.ts`; `npm run lint`; `npm run docs:check`.
