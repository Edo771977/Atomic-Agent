# PR 281 third review: open Markdown and HTML contexts

Status: current
Owner: docs/reviews/

This continues the [second review](b7a-281-review2.md) on the existing PR branch.
Main `c9aaeedadad412242b00ed230da369ffb7223f81` is integrated in `275388b93`.
Main has advanced substantially, including policy and tool-name work; final
validation therefore uses a fresh comparison on that exact main checkout.
The previous receipts remain historical snapshots at their recorded source trees.

Each point has one correction commit; the PR description maps the final commit IDs
to the observed failing controls. The [verification receipt](b7a-281-review3.json)
contains the counts, failure names and performance measurements.

| Point | Observed failing control | Final behavior |
| --- | --- | --- |
| 1 | `export-literal-context.test.ts`: 77 failures on the previous head `275388b93` with the corrected Word text extractor | A linear line scanner extends blank-line blocks through HTML types 1–5 and backtick/tilde fences. Opening, body and closing receive one size/work-budget decision, including contexts begun in a previous turn, inside a block or left unclosed. Closing a context does not introduce an extra split that would regress existing internal-fence cases. The literal fence remains outside the complete source context |
| 2 | `export-render-redaction.test.ts`: 15 initial projection failures, 8 XML-noncharacter failures and 16 structural-prefix failures | Small-block projection checks normal detector shapes even with knownSecrets empty. Invisibles, controls, compatibility forms and XML-filtered U+FFFE/U+FFFF are covered. Detector projection preserves structural underscores in ghp_/atag_; joined emphasis text is checked after Unicode normalization. Actual output is checked in all four formats; DOCX also checks raw word/document.xml |
| 3 | `export-redaction-fast-path.test.ts`: 4 failures | CRLF is normalized to LF before masking, block grouping and bounded parsing. Plain text, HTML, tilde fences and parser arguments are checked |

The first open-context test run exposed a Word text-extraction mistake: XML entities
had not been decoded. The comparable red receipt uses the corrected test, rerun in
a dedicated checkout of the unchanged previous head. Its 77 real failures are not
mixed with failures of the earlier extractor. The final matrix additionally covers
inside-block and unclosed contexts.

Open-context fixtures include comments, pre, script, style, textarea, CDATA,
processing instructions, declarations, backtick fences with language and tilde
fences. They exercise blocks above 2,048 characters, blocks after the 32K parsing
budget is exhausted, prior-turn contexts, detector-shaped synthetic values without
known keys, and actual Markdown/HTML/Word/PDF output. Twenty million-character
HTML/PDF cases cover all ten contexts with a two-second rendering budget and a
separate terminable-worker deadline. Existing flat/list-context million-character
and ordinary-turn controls remain enabled.

The corrected candidate has 514 focused controls passing. No dependency is added.
The HTTP total-turn limit, guarded export paths, ordinary-directory allowances,
TUI parser, incognito behavior and closed report vocabulary remain covered.
The documented small-inline-HTML limitation for external Markdown viewers and the
pre-existing extreme-nesting stack/work limit remain outside this block-context fix.

Final validation uses source tree `b8c7625d261d32450a0a8b8e163e8e2835832ec4`.
Lint, import boundaries and test types pass with no new diagnostics (669 existing
explicit debt diagnostics). The complete requested selection has **12,885 passed,
31 failed, 44 skipped** in 1,047 files. Fresh main has **12,307 passed, 31 failed,
44 skipped** in 1,042 files. Failure names match exactly: zero added or resolved
failures. The full suite is not reported green; all 514 focused controls pass.

Final ordinary-turn median is 3.963 ms versus main's 10.190 ms, ratio **0.389**
(limit 1.3). Twelve flat million-character cases take 27.320–172.258 ms; four
list-context cases take 77.222–170.222 ms; twenty open-context cases take
74.526–188.810 ms. Every case remains below two seconds. The optional main ratio
control is enabled. The previous six repeated-syntax cases take 1.843–8.642 ms.

Reproduce the requested checks with:

```sh
npm run lint
npm run imports:check
npm run typecheck:tests
npm run docs:check
npx vitest run src/session src/tui src/cli src/http src/error-reporting src/llm src/runtime/project-instructions.test.ts
```

Set `ATOMIC_AGENT_EXPORT_MAIN_MODULE` to the absolute main-checkout path of
`src/session/chat-export-render.ts` for the ordinary-turn ratio comparison. Final
verification enables it. The absolute million-character controls do not require
the optional reference module.
