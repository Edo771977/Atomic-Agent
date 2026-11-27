# Export and report follow-up to PR 280

Status: current
Owner: docs/reviews/

This independent PR starts at fork main `116bf48d8` (PR #280 merged), without
depending on PR #265. Origin is `https://github.com/Edo771977/Atomic-Agent.git`;
upstream is `https://github.com/AtomicBot-ai/atomic-agent.git`.

Each numbered problem has one commit. The PR description links the final commit
IDs to the following observed failing controls. [Verification](b7a-export-followup2.json)
records the final checks and failure-name comparison.

| Point | Control observed failing before correction | Final behavior and test |
| --- | --- | --- |
| 1 | 40 entity/link sentinel failures; three additional normal-detector inline failures | `export-render-redaction.test.ts`: Markdown, HTML, DOCX and PDF; numeric/hex/named references, escaped ampersands, link labels, nested block types, normal credential detection without known values |
| 2 | `budgets only the requested transcript` returns 413 instead of 200 | `route-session-export.test.ts`: tools=0 ignores thousands of calls, raw results, duplicated cloud context and skills; included oversized transcript still returns 413 |
| 3 | Both ordinary-directory cases fail | `export-file-safety.test.ts`: Policies and skills allowed; actual state/trust/configured skill roots and project instruction roots remain protected, lexically and canonically |
| 4 | README permission assertion fails | `chat-export-file.test.ts`: documents that forced replacement requests 0600 and does not copy the old mode; documentation alternative selected |
| 5 | README directory-window assertion fails | `chat-export-file.test.ts`: documents parent replacement concurrency and operator-controlled directories, as for --api-key-file; documentation alternative selected |
| 6 | Existing CLI masking test fails with inherited ATOMIC_AGENT_TOOL_CHILD=1 | `export-command.test.ts`: beforeEach explicitly clears the inherited marker; explicit child tests still refuse; CLI guide documents advisory status |
| 7 | Eight syntax/spacing assertions fail | TUI `export-command.test.ts`: ASCII/long dash path words, bare --, unclosed quotes rejected; removing an intervening flag leaves one space |
| 8 | Six type/integration assertions fail | `provider-type-vocabulary.test.ts`, `error-scrubber.test.ts`, `llama-server-client.test.ts`: four reviewed literals added, arbitrary types still dropped; prose helper explicitly internal/test-only |
| 9 | Plain ASCII known-value normalization assertion fails | `export-redaction-fast-path.test.ts`: projection skipped for plain printable ASCII; exact known-value and normal detector masking preserved; syntax/control characters keep projection |

Secret matching decodes HTML references in a projection while retaining original
source offsets. Each parsed block is also checked as joined inline presentation,
including link labels. Sensitive blocks become redacted plain text; unrelated blocks
keep their markup. HTML remains escaped and network/active-content restrictions hold.

The export writer receives the current/originating workspace roots from its callers.
It compares actual configured roots rather than banning every path segment named
Policies or skills. Recognized project instruction files and .agents/.claude remain
protected. The shared state and trust inventories remain authoritative.

The HTTP budget follows the included records and text, including requested tool
descriptions and delivered-file paths, with conservative formatting overhead. It does
not traverse the complete stored session object. Limits remain 2,000 included records
and 1,000,000 UTF-16 units; visibility/incognito checks precede the budget.

The decoder `entities` 4.5.0 was already installed as a production transitive dependency.
Only its direct dependency declarations were added to package.json and the lock root;
the existing registry resolution/integrity and installed package set are unchanged.
Its package has no preinstall/install/postinstall hook; `prepare` is `npm run build`
for package development. Promotion used offline installation with --ignore-scripts.
The final clean npm ci completed successfully.

The starting-main baseline is filtered from the completed #280 nine-area run: `116bf48d8` has the
identical verified src tree `5ba68369f4a83cd288f739d8cbe770ef369df739`. The same six
requested areas contain 12,245 passed, 23 failed and 40 skipped cases in 1,033 files.
This is reuse by exact source identity, not a claim that a fresh baseline was run.

Final setup/static/documentation checks pass, with no new test-type diagnostics
(674 existing explicit debt diagnostics) and no import cycles/exceptions. The final
requested suite has **12,318 passed, 23 failed, 40 skipped** in 1,034 files.
All 23 failures match the starting baseline by file/full test name; there are **zero
additional failures** and all new executable controls pass. The verified src tree is
`8ca0ff4211745918cbd8fd24b619c91ec82bf6e0`.

While verification completed, main advanced to `50b6d9601` by merging #265. That
change touches only src/tools/os and its guide/tests: the six requested areas and
package manifests are unchanged. This branch remains independent, with nine problem
commits and no #265 changes. The counts above remain tied to the stated verified tree.

Reproduce the final checks with:

```sh
npm ci
npm run lint
npm run imports:check
npm run typecheck:tests
npm run docs:check
npx vitest run src/session src/tui src/cli src/http src/error-reporting src/llm
```

The inherited two file-symlink cases remain skipped on this Windows account after
the previously observed EPERM. Real hardlinks and directory junctions are exercised.
