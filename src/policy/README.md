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

Policy delivery accepts HTTPS only, rejects user-info credentials and refuses redirects. A source report shows only the service origin; path/query/fragment and raw transport errors never enter `status.error` or `policy show`. The protected owner-only cache retains the exact URL solely to bind the cached policy to its source. Short-lived `skill install` and `policy show` use `loadLocalPolicy` and the validated cache; they do not refresh the network source. This is upstream's availability model, not a fresh remote-policy check: keep mandatory skill restrictions in the system file or start the operator runtime to fetch a new copy first.

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
- `resource`: bounded wildcard comparison; `*` is any run of characters including `/`, `?` one UTF-16 code unit. Default `*`. No regular expression is compiled. Resources over 128 Ki characters, patterns over 4096 characters or a comparison exceeding one million steps are unreadable: deny/ask remains restrictive and allow cannot authorize that comparison.
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
- Tool-child trust inventories retain metadata and pending counts, with skill bodies removed and loading refused; the fork's operator-only trust advice remains visible without exposing policy contents.
- Fusion and verification: workers share the dispatch/gate policy; worker candidate paths are also matched against the original project. Contract authorization and the actual rebased executor check shell denies (including stdin scripts) and explicit page/probe URLs. Detached shell jobs pass the same launch checks before becoming jobs. Fixed verification executors (including UI detectors) also check the command actually spawned. A host-retargeted file write is checked at its approved destination.

## Who manages the files

The operator edits the user policy outside agent tools. The system policy remains in the administrator-owned system location, separate from relocated user state. Its restrictions intersect with the user policy and URL/cache restrictions; moving user state cannot loosen the system file. Keep the system directory and file writable only by administrators.

The user policy, cache and system file are included in `getTrustConfigPaths` and `getStateSecretPaths`, alongside configuration and `serve-api.key`. They reach the same read-scope, shell secret scan and sandbox protection. Policy-file reads, replacement and deletion through agent tools are refused even at full trust; an approval card cannot override this refusal. The cache uses the configuration's owner-only atomic writer. `ATOMIC_AGENT_TOOL_CHILD` children (including MCP stdio servers) may bootstrap ordinary tools without policy, but cannot inspect policy through `policy show` or use a substituted state/system directory to discard inherited restrictions. There are no HTTP policy-management routes or config keys that disable policy; changing saved approval rules cannot cancel it.

These are application checks plus the existing optional OS sandbox, not isolation from arbitrary code running under the operator's OS account. Recognized shell paths receive the secret/state guard; computed paths have the same best-effort classifier limits as configuration and the serve key. Windows has no native command sandbox; requested Safe Mode refuses execution there. See [OS sandbox](../../docs/user/os-sandbox.md).

Point reads compare the exact canonical file. Listing or searching an ancestor (home, `/etc`, a filesystem root) is not a policy-file read; grep, glob and code-map exclude the protected files within those trees. Ancestor containment is retained for mutations that could replace or remove a policy. Canonical read decisions are scoped to one operation and are never retained after it.

## Not done yet

`ask` only prompts where the tool already asks the gate: shell commands that need approval, file writes, HTTP requests, gated MCP tools. `os.web.search`, read-only MCP tools and shell commands the guard deems safe honour `deny` but are not prompted on `ask`. The policy is read once per start. No cloud publishing of skills or MCP servers per organization, no admin UI.

MCP resource/prompt operations use the server selected by `args.server`: `<server>/resource.list`, `resource.read`, `prompt.list` or `prompt.get`. Dynamic tool and server names are case-sensitive, as their catalog identities are. Server names are assigned by the operator; a policy name is not an attestation of a server's executable or URL.

MCP allowlist entries are alternative selectors, retaining upstream semantics: a name-only entry authorizes any stdio command or remote endpoint configured by the operator under that name. It does not bind the name to a command/URL. To constrain transport identity, omit that name selector and list command-line or endpoint URL patterns instead. Entries within one list are OR; different sources' lists intersect. This selects configured identities, not authenticated code provenance.

Web patterns normalize scheme/host case, IDN to ASCII punycode, trailing host dots and default ports; paths remain case-sensitive. A bare host (`example.com`, `*.example.com`) covers every HTTP(S) scheme, port and path; `example.com:443` selects that effective port regardless of scheme. Use a URL form when scheme/port matters: `https://example.com` covers its default HTTPS origin, `https://example.com:8443/*` covers that origin/path pattern. MCP endpoint URL selectors receive the same URL canonicalization but remain endpoint patterns, without webfetch's origin-only shorthand. MCP tool/server names and stdio command text remain case-sensitive.

Web fetch and HTTP request check every redirect destination before the next transport call, independently of approval mode. Crawl uses the same raw-page checks for links, robots and sitemaps; cached pages and their final URLs are checked again before use.

`os.http.request` applies both policy `ask` and `deny` to the initial URL and each redirect, even with `http.approvalMode: never`. `os.web.fetch` and crawl retain upstream's read-only semantics: policy `deny` is enforced at every hop; policy `ask` alone does not create a prompt for a raw/read-only fetch. Their independent URL-data and outside-content approval checks remain in place where an approval adapter is supplied. Use `deny` for a mandatory read restriction.

HTTP(S) destinations extracted by the fork's shell URL scanner (curl/wget and explicit Git URLs, including verification stdin) also receive `webfetch`; a shell allow never substitutes for that decision. Structured clone/fetch/pull resolve configured Git URLs (including `insteadOf`) using read-only Git queries before the network command. A web `ask` requires a fresh decision even after a command pin or full-trust grant. This is the scanner's documented perimeter: a URL computed inside an arbitrary program, internal client redirects, an SSH/non-HTTP transport, or a shell Git remote name whose URL is not in argv is not a complete webfetch trace. Use shell/network egress restrictions for that perimeter.

`edit` is enforced on structured tools' actual mutation plans. Shell writes remain governed by shell rules, the fork's write/secret scanner and sandbox; `edit` is not a general filesystem monitor for arbitrary shell code.

Edit patterns and targets share canonical path normalization in the gate, dispatch and mutation plans: relative prefixes use that call's working directory, separators become `/`, and win32/darwin compare without case (including drive letters). Literal prefixes before a wildcard are canonicalized too. A leading wildcard remains a global wildcard, so `*.txt` still covers matching files at any depth. Canonicalization caches are scoped to one evaluation; they cannot retain an obsolete symlink decision between calls. Batch preflight passes the session working directory explicitly.

Mutation policy is checked on actual plans in `requireFsApproval`, before fanout grants or disabled ordinary approvals can settle the call. This covers Office, code rewrite and canvas without a tool-name list. Move/trash check both ends and possible descendants; a directory operation is conservative when its descendants can intersect a restrictive glob. Archives pass every listed entry separately, rather than treating the destination folder as every file it might contain. Git checkout obtains a complete read-only diff before approval; Git metadata (including shared worktree metadata) and staged paths are also checked. An uninspectable checkout plan is refused. Video render checks its resolved output before ffmpeg; generated video checks the actual copy destination (the remote job has its separate paid-generation approval). Fusion checks all changed original-project paths before copying any of them; an `ask` holds promotion for the operator rather than opening an invisible worker prompt.

Remote Git verbs retain local edit checks: clone checks its new tree, fetch/push and remote configuration changes check metadata, and pull checks possible worktree descendants before its combined fetch/integration operation. Pull is conservative because its future worktree is unknown before contacting the remote; use a separately permitted fetch and a planned checkout when that distinction matters. The fork's `git_remote` approval and remote-sync switch remain independent.

## Entry points

- [policy-schema.ts](policy-schema.ts): the file format and its parser.
- [policy-evaluator.ts](policy-evaluator.ts): rule order, strictest source wins, the MCP allowlists.
- [policy-loader.ts](policy-loader.ts): files, URL, cache.
- [policy-targets.ts](policy-targets.ts): a gate request or a tool call as action and resources.
- [policy-enforce.ts](policy-enforce.ts): answers for the gate, the dispatcher, skills and MCP.
- [policy-active.ts](policy-active.ts): the policy installed at boot.
- [policy-paths.ts](policy-paths.ts), [policy-mutations.ts](policy-mutations.ts): canonical identities, protected read exclusions and complete mutation plans.
- [policy-web.ts](policy-web.ts), [policy-web-identity.ts](policy-web-identity.ts): independent destination decisions and URL/host identities.

## Validation

`npx vitest run src/policy src/approval/approval-gate-org-policy.test.ts src/agent/dispatch/batch-gates.test.ts src/mcp/mcp-manager.test.ts src/skills/skill-installer.test.ts src/cli/policy-command.test.ts`; `npm run lint`; `npm run docs:check`.

## Tool-child bootstrap

The launcher pins the original state and system-policy paths in reserved child metadata; MCP server env overrides cannot replace them. Children intersect those local files with their own context and every validated cache, including when the delivery URL has been removed from the environment. They do not fetch. Child sources ignore allow rules, so combining contexts can only add restrictions; operator commands remain reserved. A malformed child cache refuses startup. A fresh remote policy must be persisted before parent startup succeeds, otherwise children could obtain an older, weaker snapshot. This deliberately tightens upstream’s cache-write availability exception; download failures still retain the documented cache fallback.
