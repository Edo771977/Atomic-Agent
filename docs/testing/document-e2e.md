# Document delivery end-to-end fixture

Status: current
Owner: repository maintainers

The [brief](fixtures/document/brief.txt) asks for a weekly service report in
English. The [test](../../src/tools/verify/document-check.test.ts) executes these
files through the `verify.run` tool with the same criteria:

| Report | Expected result |
| --- | --- |
| [Reference](fixtures/document/reference.md) | Passes all document criteria. |
| [Missing section](fixtures/document/missing-section.md) | Fails because the title “Next steps” is missing. |
| [Placeholder](fixtures/document/placeholder.md) | Fails because the report still contains `[insert]`. |

Run from the repository root:

```sh
npx vitest run src/tools/verify/document-check.test.ts
```

The tool's working folder is `docs/testing/fixtures`. The reference run uses:

```json
{
  "kind": "document",
  "path": "document/reference.md",
  "requiredSections": ["Summary", "Next steps"],
  "wordRange": { "min": 55, "max": 85 },
  "language": "en"
}
```

Markdown section titles must be headings. Word titles use the standard Mammoth
heading styles. PDF and plain text use standalone lines. Titles are compared
after Unicode normalization, lowercasing and whitespace collapse. The inclusive
word range counts letter or number sequences and keeps internal apostrophes
and hyphens within a word. Markdown links contribute their labels. The default
placeholder markers are checked on every run and `extraPlaceholders` can add
literal markers.

The language heuristic checks English, Italian, Spanish, French, German and
Portuguese (`en`, `it`, `es`, `fr`, `de` and `pt`) using common function
words. It requires at least 20 words, five distinct markers for the leading
language, a lead of at least three distinct markers over the next candidate,
and at least 10% of document words matching the leader's markers. If the
evidence is insufficient the document is uncheckable. A confident mismatch
fails the check. The fixture runs locally without models or external services.
