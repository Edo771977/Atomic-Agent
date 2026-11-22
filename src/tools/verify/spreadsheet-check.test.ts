import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { evaluateSpreadsheet, parseSpreadsheetSpec } from "./spreadsheet-check.js";

const reconciliation = {
  requiredSheets: ["CSV"],
  requiredColumns: [{ sheet: "CSV", columns: ["Item", "Amount"] }],
  totals: [{ sheet: "CSV", range: "b", totalCell: "B5", tolerance: 0.0001 }],
};

function csv(text: string, raw: Record<string, unknown> = reconciliation) {
  return evaluateSpreadsheet(Buffer.from(text), ".csv", parseSpreadsheetSpec(raw));
}

async function xlsx(...values: ExcelJS.CellValue[]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  values.forEach((value, index) => {
    sheet.getCell(index + 1, 1).value = value;
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("spreadsheet verification", () => {
  it("accepts quoted UTF-8 CSV, decimal rounding within tolerance, and blank rows", async () => {
    const result = await csv('\uFEFF" Item ",amount\r\n"café, tea",0.1\r\n\r\nwater,0.2\r\nTotal,0.3\r\n');
    expect(result.status).toBe("pass");
  });

  it("derives the expected sum from changed data and points to the wrong total", async () => {
    const result = await csv("Item,Amount\nTea,0.5\n\nWater,0.2\nTotal,0.3\n");
    expect(result).toMatchObject({ status: "fail", detail: expect.stringMatching(/CSV.*B5.*0\.7/) });
  });

  it("identifies missing sheets and headers", async () => {
    expect(await csv("Item,Cost\n")).toMatchObject({ status: "fail", detail: expect.stringContaining("Amount") });
    expect(await csv("Item,Amount\n", { requiredSheets: ["Sales"] })).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("Sales"),
    });
  });

  it.each(["#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A"] as const)(
    "reports the address of the cached XLSX formula error %s",
    async (error) => {
      const data = await xlsx("Header", { formula: "B1", result: { error } });
      const result = await evaluateSpreadsheet(data, ".xlsx", parseSpreadsheetSpec({}));
      expect(result).toMatchObject({ status: "fail", detail: expect.stringContaining(`"Data"!A2: ${error}`) });
    },
  );

  it("fails closed when a formula has no cached value, and accepts a cached zero", async () => {
    expect(await evaluateSpreadsheet(await xlsx({ formula: "0" }), ".xlsx", parseSpreadsheetSpec({})))
      .toMatchObject({ status: "uncheckable", detail: expect.stringContaining('"Data"!A1') });
    expect((await evaluateSpreadsheet(await xlsx({ formula: "0", result: 0 }), ".xlsx", parseSpreadsheetSpec({}))).status)
      .toBe("pass");
  });

  it("reports CSV error markers and cannot check malformed CSV or unsupported formats", async () => {
    expect(await csv("Item,Amount\nTea,#REF!\n", {})).toMatchObject({
      status: "fail", detail: expect.stringContaining('"CSV"!B2'),
    });
    expect((await csv('Item,Amount\n"unfinished"extra,1\n', {})).status).toBe("uncheckable");
    expect((await evaluateSpreadsheet(Buffer.from("legacy"), ".xls", parseSpreadsheetSpec({}))).status)
      .toBe("uncheckable");
  });

  it("requires numeric data and totals without coercing nonblank invalid data", async () => {
    const all = "Item,Amount\nTea,0x1\nWater,boo\nTotal,1\n";
    const raw = { totals: [{ sheet: "CSV", range: "B2:B3", totalCell: "B4", tolerance: 0 }] };
    expect(await csv(all, raw)).toMatchObject({ status: "fail", detail: expect.stringContaining('"CSV"!B2') });
    expect((await csv(all.replace("0x1", "").replace("boo", "").replace("Total,1", "Total,0"), raw)).status)
      .toBe("fail");
  });

  it("returns uncheckable beyond the cell or sheet cap", async () => {
    expect(await csv(",".repeat(100_000), {})).toMatchObject({
      status: "uncheckable", detail: expect.stringMatching(/cell limit/),
    });
    const workbook = new ExcelJS.Workbook();
    for (let i = 1; i <= 33; i++) workbook.addWorksheet(`Data ${i}`);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(await evaluateSpreadsheet(bytes, ".xlsx", parseSpreadsheetSpec({}))).toMatchObject({
      status: "uncheckable", detail: expect.stringMatching(/sheet limit/),
    });
  });

  it("returns uncheckable for invalid UTF-8 or an empty CSV", async () => {
    expect((await evaluateSpreadsheet(Buffer.from([0xc0]), ".csv", parseSpreadsheetSpec({}))).status).toBe("uncheckable");
    expect((await csv(", ,\n", {})).status).toBe("uncheckable");
  });

  it.each([
    { tolerance: Infinity },
    { tolerance: -1 },
    { tolerance: undefined },
    { range: "A0" },
    { range: "XFE1" },
    { range: "B3:B2" },
    { range: "B2:B5" },
    { expected: 123 },
  ])("rejects invalid total specifications %j", (override) => {
    expect(() => parseSpreadsheetSpec({ totals: [{ ...reconciliation.totals[0], ...override }] })).toThrow(/totals\[0\]/);
  });
});
