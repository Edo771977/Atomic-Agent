import type { Worksheet } from "exceljs";
import { expect, it, vi } from "vitest";
import { chartDataFromSheet } from "./xlsx-chart.js";
import { parseXlsxArgs } from "./xlsx-tool.js";

it.each([["A1:B502", /500.*points/i], ["N2:A1", /12.*series/i]])(
  "rejects chart range %s before touching cells",
  (range, message) => {
    const getCell = vi.fn(() => { throw new Error("a cell was allocated"); });
    expect(() => parseXlsxArgs({ path: "book.xlsx", op: "chart", range })).toThrow(message);
    expect(() => chartDataFromSheet({ getCell } as unknown as Worksheet, { type: "column", range })).toThrow(message);
    expect(getCell).not.toHaveBeenCalled();
  },
);
