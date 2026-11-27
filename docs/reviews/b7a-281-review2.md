# PR 281 second review: presentation joins and literal fallback

Status: current
Owner: docs/reviews/

This continues PR #281 on its existing branch after the [first review](b7a-281-review.md).
Main `104b6f7e6` was integrated in `18ada828b`. That main advance adds C2a/C2b
deferral evidence/tests and documentation; it does not change production behavior.
The previous review remains a historical receipt at its stated source tree.

Each point below has its own correction commit, linked in the PR description.
The [verification receipt](b7a-281-review2.json) records the observed red controls,
final checks, timings and a fresh failure-name comparison against this main.

| Point | Test observed failing before correction | Final behavior |
| --- | --- | --- |
| 1 | 41 failures in `export-render-redaction.test.ts` | Small blocks with backticks, forced breaks, cell separators or backslashes cannot bypass bounded inline parsing. The joined presentation uses trimmed code-span text, joined hard breaks and adjacent cells. Known synthetic sentinels and a vendor-shaped sentinel without knownSecrets are checked on actual Markdown/HTML/DOCX/PDF output, including surrounding text. Existing parser budgets and ordinary-text performance controls remain; twelve flat million-character cases must finish within two seconds |
| 2 | All 16 controls in `export-literal-context.test.ts`: twelve literal-output failures and four worker deadlines | Column-zero code fences close the preceding ordered/bulleted nested-list context and exceed every internal backtick run. Repeated masking preserves verified complete literal fences. Actual Markdown/HTML/PDF retain the literal emphasis delimiters, including fixtures with internal fences. Million-character HTML/PDF fixtures in both list contexts must render within two seconds; workers enforce an independent five-second test deadline |
| 3 | Sixteen NBSP entity/literal controls in `export-render-redaction.test.ts` | Known-value projection treats decoded NBSP as removable before compatibility normalization. Named, decimal, hexadecimal and literal NBSP are covered in all four formats. Optional small correction implemented |
| 4 | Documentation contract in `export-markdown-limit.test.ts` | Optional documentation alternative selected. The session guide records the pre-existing stack/deep-structure limitation on main; no new depth cap is claimed |

The main-only depth probe used synthetic text in terminable workers. HTML and PDF
both throw RangeError for 10,000 nested quote markers (20,007 characters). For
2,000 nested list levels (4,017,999 characters), both exceed a five-second worker
deadline. These are recorded limitations, not passing time-budget cases. Flat and
bounded-list-context million-character controls remain separate. The raw-HTML
Markdown presentation limitation documented in the first review also remains.

The 20,000-total-turn HTTP ceiling, instruction/state/trust/skill path protections,
ordinary Policies/skills allowances, closed provider-error vocabulary and Unicode
dash TUI parser are retained. No dependency was added. All fixtures use disposable
state or synthetic strings; no personal chat or credential is used.

The final source tree is `f644b5f1fe8fc8d068cc48a7c4cfc48e329b962d`.
Lint, dependency boundaries, test types and documentation checks pass with no new
type diagnostics (674 existing explicit debt diagnostics). All 202 focused controls
pass. The complete requested selection has **12,545 passed, 25 failed, 41 skipped**
in 1,040 files; fresh main has **12,279 passed, 25 failed, 41 skipped** in 1,035
files. The failure names match exactly: zero added or resolved failures. The suite
is not reported green.

Final timings: ordinary 1,000-turn-pair median 3.494 ms versus main's 14.187 ms,
ratio **0.246** (limit 1.3). The twelve flat million-character cases take
21.010–222.658 ms; four list-context million-character cases take 78.192–231.113 ms.
All remain below two seconds. The six previous syntax controls take 1.376–8.904 ms,
and the optional ordinary-turn ratio control was enabled rather than skipped.

Reproduce the final checks with:

```sh
npm run lint
npm run imports:check
npm run typecheck:tests
npm run docs:check
npx vitest run src/session src/tui src/cli src/http src/error-reporting src/llm src/runtime/project-instructions.test.ts
```

Set `ATOMIC_AGENT_EXPORT_MAIN_MODULE` to the absolute main-checkout path of
`src/session/chat-export-render.ts` for the same-process ordinary-turn ratio control.
The final verification enables it. Million-character absolute budgets and worker
deadlines do not require the optional main module.
