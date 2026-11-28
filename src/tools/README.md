# Tool registry and adapters

Status: current
Owner: src/tools/

This area owns tool registry and adapters. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

C4a keeps files.search and its background chosen-folder index unavailable until scanning, persistence, embeddings and search share the fork's protected-input, read-scope and secret-masking boundaries. [Review and reopening tests](../../docs/reviews/c4a-files-index.md).

C4b also leaves automatic sqlite-vec loading and the optional HTTP reranker unavailable. Reopening needs a protected pinned extension location and the ordinary model policy/privacy boundaries; keyword and memory search keep their current behavior. [Candidate audit](../../docs/reviews/c4b-vec-rerank.md).

- [tool-registry.ts](tool-registry.ts): `dispatchGuard` / `refusalBeforeDispatch` refuse a call before hooks, approval and the tool itself
- [tool-egress.ts](tool-egress.ts): which calls send content off the machine, by `allowedEgress` class, and the per-folder refusal ([provider policy](../llm/docs/provider-policy.md#egress-allowedegress))
- [URL data guard](os/web/url-data-guard.ts): dispatch checks for data-bearing URLs in HTTP GET, web fetch and explicit browser navigation, with per-hop checks in the guarded curl paths.
- [tool-roles.ts](tool-roles.ts)
- [unknown-argument-guard.ts](unknown-argument-guard.ts)
- [argument-aliases.ts](argument-aliases.ts)
- [control-marker-guard.ts](control-marker-guard.ts)
- [tool-output-spill.ts](tool-output-spill.ts)
- [untrusted-tool-output.ts](untrusted-tool-output.ts)
- [tool-output-secrets.ts](tool-output-secrets.ts)
- [verify/](verify/README.md): `verify.run` / `verify.syntax`, the check language, the page game harness and screenshots
- [describe-tool-call.ts](describe-tool-call.ts): a tool call as one readable line ("Read config.ts", "Ran npm test · failed") for the TUI, Telegram and desktop frames

## Ownership and dependencies

ToolRegistry owns registered definitions and invocation; role predicates and discovery determine offered schemas. OS/browser/memory/conversation tool families implement operations using explicit ToolContext dependencies. Agent dispatch owns approval, batching and progress guards; prompt owns descriptors and LLM adapters own wire schemas. A catalog change crosses these boundaries.

[Core filesystem contracts](os/fs/docs/contracts.md) group 14 operations' metadata and pure argument semantics. [Global conformance](tool-contract-conformance.test.ts) inspects actual static registrations before replacement and catalog/schema/class surfaces; [runtime composition tests](../runtime/tool-contract-composition.test.ts) pin feature gates and read-scope decoration. See [contracts](docs/contracts.md) for validation limits and existing catalog debt.

In local mode the registry hands a clipped result of an allowlisted tool (commands, listings, searches, diffs) to [the output spill](tool-output-spill.ts): the complete `fullOutput` is written to an owner-only temp folder of the session, bounded per file and per session, and the summary leads with the path so the model reads a slice with `os.fs.read` instead of re-running the command. The folder is in that session's read scope (a worker's too), is removed with the session and is swept at start once stale. Cloud mode keeps promoting the full output instead; an incognito chat (`ToolContext.incognito`, ATO-586) spills nothing.

Spill files request POSIX modes 0600 and directories 0700. On Windows Node ignores those permission bits and the inherited directory ACL controls access; a POSIX mode assertion does not verify Windows privacy. Link checks and session containment still apply on every platform.

Before any of that, the registry masks credentials in every result except `reply` and `finish` ([tool-output-secrets.ts](tool-output-secrets.ts), ATO-1077): summary, kept full output, the two details the step puts in the prompt (`worldSnapshot.text`, `skillLoaded.body`) and a thrown error or value. Vendor key shapes, bearer/basic/cookie headers, JWTs, PEM private keys, URL passwords and secret-named `NAME=value` pairs become `[redacted:<hint>]`, and so do the exact values of the agent's own `.env` variables and the credentials in its config (provider keys and secret headers, the local server key, webhook secrets, MCP servers' secret env values and headers). The detector is shared with the error scrubber ([secret-detector.ts](../error-reporting/secret-detector.ts)); because masking comes first, the cloud promotion, the spill file and the untrusted framing only ever see the marker. Other `details` are left as the tool wrote them for the step's state effects; the prompt does not render them, and the copies written to disk (the trace row and the session's latest result) are masked string by string (`maskSecretsDeep`, ATO-1176). The compressor masks a summary before cutting it, so a cut cannot leave half a key. `os.fs.write` / `edit` / `patch` refuse a change that adds a marker the file did not already hold ([guard](os/fs/fs-masked-secret-guard.ts)), so a rewrite of a masked `.env` cannot replace the real keys with markers.

## Task-specific reading

Read docs/contracts.md for tool additions/changes and ../agent/docs/batching.md for dispatch; adjacent tool tests for argument behavior.

## Validation

`npx vitest run src/tools`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).

C1e keeps subagent.run absent from registration, the production catalog and grammar. Upstream's unpriced cloud accounting and active-turn child ledger do not meet the fork's hard limits. [Candidate audit](../../docs/reviews/c1e-subagent-run.md).
