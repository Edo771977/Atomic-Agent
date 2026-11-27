# PR 281 review corrections

Status: current
Owner: docs/reviews/

This review continues PR #281 on its existing branch. Main `50b6d9601` was
integrated before the corrections (`50c41d1f8`), including the already merged
document-extraction PR #265. The [original nine-point receipt](b7a-export-followup2.md)
is a historical snapshot at its stated source tree, not the final state below.
Origin and upstream remain the repositories recorded in that receipt.

Each of the following six problems has one correction commit; the PR description
maps its final commit ID to the observed failing controls. The
[machine-readable receipt](b7a-281-review.json) records counts, failure names and
same-process main performance comparisons.

| Point | Observed failing control before correction | Result |
| --- | --- | --- |
| 1 | `export-work-budget.test.ts`: ordinary 1,000-pair ratio 4.01 times main; PDF repeated links 2,007 ms; unbounded parser inputs. Additional reference-label sentinel controls failed in all four formats, plus the normal detector without known values | Linear whole-string projection prefilter, bounded candidate blocks (2,048 characters each / 32,768 parser characters per document), conservative linked-label checks including cross-block references, literal/redacted oversized blocks. Repeated links/delimiters tested in Markdown, HTML and PDF; ordinary pair ratio must be at most 1.3 times main |
| 2 | `export-instruction-protection.test.ts`: 39 nested/ancestor/profile/lowercase destination failures | Discovery and export protection share root/foreign instruction names, Cursor rules and PROJECT_AGENT_DIRS. Protection covers every project depth and cwd ancestors to the Git root, with Darwin/Windows case aliases. Ordinary Policies and skills remain writable |
| 3 | `route-session-export.test.ts`, `bounds total stored turns even when tool results are excluded`: 200 instead of 413 | Independent 20,000 stored-turn ceiling before transcript work, even with tools=0. Growth controls at 1,000, 10,000 and 20,000 records preserve short ordinary transcripts; 20,001 returns 413. Existing requested-transcript and visibility limits remain |
| 4 | `export-redaction-fast-path.test.ts`: backslash, less-than and escaped-hyphen assertions failed | Backslash and `<` retain projection. The synthetic escaped-hyphen sentinel is also covered by Markdown, HTML, DOCX and PDF renderer controls |
| 5 | `export-markdown-limit.test.ts`: guide lacked the raw HTML presentation limit | Documentation alternative selected: the session guide explicitly describes raw HTML tags/comments hidden by external Markdown viewers as a pre-existing masking limitation. This correction makes no claim to eliminate that limitation |
| 6 | TUI `export-command.test.ts`: eleven additional Unicode dash/minus cases failed | Every path word starting with category Pd or U+2212 is rejected, including quoted words; explicit ./ filenames remain accepted |

Existing masking/entity/link controls, exclusive writes, symlink/hardlink and resolved
state/trust/skill path guards, ordinary directory allowances and closed provider-error
classification are retained. No dependency was added by this review. Shared definition
identity controls cover the instruction and profile loaders; their behavior is
otherwise unchanged. The profile-loader symlink failure is also reproduced on main
on this Windows account.

The fresh main run additionally encountered an EBUSY cleanup failure in
`session-worktree.test.ts`. Its separate main rerun passes all eight cases;
the complete final branch run also passes all eight. Raw suite counts retain
that baseline failure, and the receipt compares failure names without silently
substituting the rerun for the suite result.

The conservative subsequence check can redact an entire linked candidate block.
Large/exhausted blocks can lose Markdown formatting by becoming literal code. HTTP
exports above the stored-turn ceiling must use the terminal. The documented parent
directory replacement window and forced-replacement 0600 behavior remain unchanged.

Final validation uses source tree `8b768992b9d28f4ebbfeb5c57916ab8b23443734`.
Lint, import boundaries and test types pass with zero new diagnostics (674 existing
explicit debt diagnostics). The final selected suite has **12,441 passed, 25 failed,
41 skipped** in 1,038 files. Fresh main has **12,271 passed, 26 failed, 41 skipped**
in 1,034 files. All 25 final failures match main by file/full test name; there are
zero added failures. Main's extra EBUSY cleanup failure is retained in the raw counts
and passes its separate rerun as described above. The suite is not reported green.

Final same-process performance measures 2.212 ms versus main's 12.276 ms for 1,000
ordinary turn pairs (ratio **0.180**, below 1.3). The six repeated-syntax cases take
0.984–13.558 ms, all below 2 seconds. No ratio control was skipped in this run.

Reproduce static and selected-suite checks with:

```sh
npm run lint
npm run imports:check
npm run typecheck:tests
npm run docs:check
npx vitest run src/session src/tui src/cli src/http src/error-reporting src/llm src/runtime/project-instructions.test.ts
```

Set `ATOMIC_AGENT_EXPORT_MAIN_MODULE` to the absolute path of
`src/session/chat-export-render.ts` in a separate clean main checkout to enable
the 1,000-pair same-process ratio assertion. Without that optional reference only
the ratio assertion is skipped; the six absolute-time syntax controls still run.
