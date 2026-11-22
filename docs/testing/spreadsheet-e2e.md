# Spreadsheet verification end-to-end fixture

Status: current
Owner: repository maintainers

Verify a sales workbook with a `Sales` sheet and `Item` and `Amount` headers in row 1. Add the amounts in B2 and B3 and compare the result with B4 within an absolute tolerance of 0.01. Report spreadsheet errors with their cell address.

## Files

| Workbook | Expected `verify.run` result |
| --- | --- |
| [sales.xlsx](fixtures/spreadsheet/sales.xlsx) | Pass. Two amounts of 12.50 add up to 25.00, matching the total formula's cached value. |
| [formula-error.xlsx](fixtures/spreadsheet/formula-error.xlsx) | Fail. `Sales!B3` contains a cached `#REF!` error. |
| [wrong-total.xlsx](fixtures/spreadsheet/wrong-total.xlsx) | Fail. `Sales!B4` contains a cached total of 26.00, while the two data cells add up to 25.00. |

Run all three cases from the repository root. The [test](../../src/tools/verify/spreadsheet-e2e.test.ts) invokes the registered tool implementation on each workbook and checks the status and failure detail. The fixtures use saved formula results, so the run requires no spreadsheet application or network access. Opening and resaving the wrong-total fixture in an application that recalculates formulas can replace its intentionally incorrect cached total.

```sh
npx vitest run src/tools/verify/spreadsheet-e2e.test.ts
```

This is the `verify.run` call used for the reference workbook, with the fixture folder as the working directory.

```json
{
  "kind": "spreadsheet",
  "path": "sales.xlsx",
  "requiredSheets": ["Sales"],
  "requiredColumns": [{ "sheet": "Sales", "columns": ["Item", "Amount"] }],
  "totals": [{ "sheet": "Sales", "range": "B2:B3", "totalCell": "B4", "tolerance": 0.01 }]
}
```
