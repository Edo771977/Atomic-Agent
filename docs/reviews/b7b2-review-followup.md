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

The catalog side is ASCII-only too: two further red assertions showed that an ASCII emitted name could otherwise fold a registered Kelvin-sign name back to ASCII, both for a built-in shape and a raw MCP tool. The same correction excludes non-ASCII candidates before comparison. The final nine-suite selection passes all 126 assertions, including both directions. These results are retained in the same evidence record.

## 3. Refuse template markers

Names containing `<|` (or its literal HTML-escaped spelling `&lt;|`) are refused before exact lookup. The wrapping helper no longer truncates a template tail. Five assertions were red on the preceding source; all 50 resolver/dispatch tests pass after the guard. Ordinary bounded quote/call/punctuation handling remains. [Red/green evidence](b7b2-review-markers.json).

## 4. Rewrite canonical continuations before progress extraction

The parser resolves names before passing a batch to its continuation rewrite, then extracts progress text from the joined answer. The same helper runs on the repaired parse path, where the rewrite was previously omitted. No new await or inference is added.

Four lifecycle cases were red first: `functions.reply` and `Reply`, each on the initial and repaired parse path. They use the real continuation join and progress policy, verify the full joined progress note, and check that provider calls and the prepared prompt remain unchanged. The lifecycle, continuation and dispatch suites then pass. [Red/green evidence](b7b2-review-continuation.json).

## 5. Bound the admission-backstop debug name

The admission backstop now uses `logTextPreview(call.tool, 80)`, matching `resolveBatchToolNames`: at most 80 source characters plus the truncation ellipsis. One actual-backstop logger assertion was red first; all 79 resolver, lifecycle, continuation and dispatch tests pass after the correction. The canonical tool name, dispatch and external report vocabulary are unchanged. [Red/green evidence](b7b2-review-debug.json).

## Final verification

The final [nine-file targeted run](b7b2-review-targeted.json) passes **126 tests**, with no failures or skips. It includes resolver, actual dispatch/approval boundaries, lifecycle, continuation, MCP approval integration, unknown-tool admission, turn filter, reliability classification and runtime trace/report controls. The updated MCP integration fixture varies raw-tool separators while preserving the literal server name and still checks approval under the real registered identity.

`npm run lint`, `npm run imports:check`, `npm run typecheck:tests` and `npm run docs:check` all pass on the final ASCII input/catalog guard. No type-debt allowance, timeout, skip or quarantine was added. The production corrections change only `tool-name-resolution.ts`, `step-batch-parsing.ts` and `step-evidence.ts`; export, subagent/profile/shared-runner sources, stable prompt source and report vocabulary are unchanged by this review.

The required broader selection is:

```text
npx vitest run src/agent src/policy src/approval src/mcp src/tools src/llm/reliability src/runtime
```

It completed on the final source: **14,582 passed, 138 failed, 546 skipped**, in 916 files, with no suite-load errors. All 138 failure names also fail in the previously recorded complete-main `7511497b0` run; there are **zero additional failures** by file/fullName. Only checkout roots and slash direction are normalized. [Every failure and raw-report hashes](b7b2-review-comparison.json). This is a comparison with that pinned baseline, not a new complete-main run or a claim that the required selection is green. The tested branch includes main `54f81900b`, including its W1 tests and B7b3 absence checks.

Two earlier partial attempts were interrupted before completion while the MCP integration fixture and the reverse Kelvin case were completed; neither is reported as a successful check. The completed final run above uses the final source, after all five corrections. Its targeted suite and static checks were also rerun after the final ASCII input/catalog guard.
