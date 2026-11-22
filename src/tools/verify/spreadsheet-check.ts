import { Readable } from "node:stream";
import type { Cell, CellValue, Worksheet } from "exceljs";

const MAX_SHEETS = 32;
const MAX_CELLS = 100_000;
const MAX_ROW = 1_048_576;
const MAX_COLUMN = 16_384;
const MAX_RULES = 32;
const ERROR_MARKERS = new Set([
  "#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NULL!", "#NUM!",
  "#SPILL!", "#CALC!", "#GETTING_DATA", "#BLOCKED!", "#CONNECT!", "#FIELD!", "#UNKNOWN!",
]);

type Outcome = { status: "pass" | "fail" | "uncheckable"; detail: string };

interface TotalCheck {
  readonly sheet: string;
  readonly range: string;
  readonly totalCell: string;
  readonly tolerance: number;
}

export interface SpreadsheetSpec {
  readonly requiredSheets: readonly string[];
  readonly requiredColumns: readonly { sheet: string; columns: readonly string[] }[];
  readonly totals: readonly TotalCheck[];
}

interface Area {
  minColumn: number;
  maxColumn: number;
  minRow: number;
  maxRow: number;
  entireColumn: boolean;
}

function invalid(field: string, reason: string): never {
  throw new Error(`verify.run: \`${field}\` ${reason}`);
}

function list(value: unknown, field: string): unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_RULES) {
    invalid(field, `must be an array of up to ${MAX_RULES} entries`);
  }
  return value;
}

function name(value: unknown, field: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    invalid(field, `must be a non-empty string of at most ${limit} characters`);
  }
  return value;
}

function object(raw: unknown, field: string, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid(field, "must be an object");
  const unexpected = Object.keys(raw).find((key) => !keys.includes(key));
  if (unexpected) invalid(`${field}.${unexpected}`, "is not supported");
  return raw as Record<string, unknown>;
}

function columnNumber(label: string): number {
  let col = 0;
  for (const letter of label) col = col * 26 + letter.charCodeAt(0) - 64;
  return col;
}

function coordinate(value: string, field: string): { row: number; column: number } {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value);
  if (match) {
    const row = Number(match[2]);
    const column = columnNumber(match[1]!);
    if (row <= MAX_ROW && column <= MAX_COLUMN) return { row, column };
  }
  return invalid(field, "must be an A1 cell address within Excel's grid");
}

function area(range: string, field: string): Area {
  if (/^[A-Z]{1,3}$/.test(range)) {
    const col = columnNumber(range);
    if (col > MAX_COLUMN) invalid(field, "must be a column within Excel's grid");
    return { minColumn: col, maxColumn: col, minRow: 2, maxRow: MAX_ROW, entireColumn: true };
  }
  const [first = "", last = first, extra] = range.split(":");
  if (extra !== undefined) invalid(field, "must be a column letter, A1 cell, or A1 range");
  const start = coordinate(first, field);
  const end = coordinate(last, field);
  if (start.column > end.column || start.row > end.row) invalid(field, "must run from upper left to lower right");
  return { minColumn: start.column, maxColumn: end.column, minRow: start.row, maxRow: end.row, entireColumn: false };
}

function includes(bounds: Area, row: number, column: number): boolean {
  return row >= bounds.minRow && row <= bounds.maxRow && column >= bounds.minColumn && column <= bounds.maxColumn;
}

export function parseSpreadsheetSpec(raw: Record<string, unknown>): SpreadsheetSpec {
  return {
    requiredSheets: list(raw.requiredSheets, "requiredSheets")
      .map((sheet, i) => name(sheet, `requiredSheets[${i}]`, 31)),
    requiredColumns: list(raw.requiredColumns, "requiredColumns").map((entry, i) => {
      const field = `requiredColumns[${i}]`;
      const rule = object(entry, field, ["sheet", "columns"]);
      const columns = list(rule.columns, `${field}.columns`)
        .map((column, j) => name(column, `${field}.columns[${j}]`, 128));
      if (!columns.length) invalid(`${field}.columns`, "must include at least one header");
      return { sheet: name(rule.sheet, `${field}.sheet`, 31), columns };
    }),
    totals: list(raw.totals, "totals").map((entry, i) => {
      const field = `totals[${i}]`;
      const rule = object(entry, field, ["sheet", "range", "totalCell", "tolerance"]);
      const sheet = name(rule.sheet, `${field}.sheet`, 31);
      const range = name(rule.range, `${field}.range`, 24).toUpperCase();
      const totalCell = name(rule.totalCell, `${field}.totalCell`, 11).toUpperCase();
      const bounds = area(range, `${field}.range`);
      const total = coordinate(totalCell, `${field}.totalCell`);
      if (!bounds.entireColumn && includes(bounds, total.row, total.column)) {
        invalid(`${field}.range`, "must exclude the total cell");
      }
      const tolerance = rule.tolerance;
      if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0) {
        invalid(`${field}.tolerance`, "must be an explicit finite non-negative number");
      }
      return { sheet, range, totalCell, tolerance };
    }),
  };
}

function failed(detail: string): Outcome {
  return { status: "fail", detail };
}

function uncheckable(detail: string): Outcome {
  return { status: "uncheckable", detail };
}

function location(sheet: Worksheet, address: string): string {
  return `${JSON.stringify(sheet.name)}!${address}`;
}

function cellValue(cell: Cell | undefined): CellValue {
  // ExcelJS's public value object drops falsy formula caches, including zero.
  return cell?.formulaType ? cell.result : cell?.value;
}

function headerText(value: CellValue): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    if ("richText" in value) return value.richText.map((segment) => segment.text).join("");
    if ("hyperlink" in value) return value.text;
  }
  return "";
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase();
}

function numberValue(value: CellValue, csv: boolean): number | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (csv && /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][-+]?\d+)?$/.test(trimmed)) {
    value = Number(trimmed);
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function csvExceedsCellLimit(source: string): boolean {
  // Count fields before ExcelJS turns them into cell objects. Its parser
  // handles syntax validation, including escaped quotes and quoted newlines.
  let count = 0;
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === "," || char === "\n" || (char === "\r" && source[i + 1] !== "\n")) {
      if (++count > MAX_CELLS) return true;
    }
  }
  return count === MAX_CELLS && !/[\r\n]$/.test(source);
}

function totalFailure(sheet: Worksheet, rule: TotalCheck, csv: boolean): Outcome | undefined {
  const bounds = area(rule.range, "range");
  const total = coordinate(rule.totalCell, "totalCell");
  const where = location(sheet, rule.totalCell);
  const actual = numberValue(cellValue(sheet.findCell(total.row, total.column)), csv);
  if (actual === undefined) return failed(`${where}: total cell must contain a finite number`);

  let sum = 0;
  let count = 0;
  let nonNumeric: string | undefined;
  sheet.eachRow((row, rowNumber) => {
    if (nonNumeric || rowNumber < bounds.minRow || rowNumber > bounds.maxRow) return;
    row.eachCell((cell, col) => {
      if (nonNumeric || !includes(bounds, rowNumber, col) || cell.address === rule.totalCell) return;
      const value = cellValue(cell);
      if (value == null || typeof value === "string" && !value.trim()) return;
      const numeric = numberValue(value, csv);
      if (numeric === undefined) nonNumeric = location(sheet, cell.address);
      else {
        count++;
        sum += numeric;
      }
    });
  });
  if (nonNumeric) return failed(`${nonNumeric}: expected a finite number in total range ${rule.range}`);
  if (!count) return failed(`${where}: range ${rule.range} contains no numeric data`);
  if (!Number.isFinite(sum)) return uncheckable(`${where}: summing ${rule.range} exceeded the finite numeric range`);
  if (Math.abs(actual - sum) > rule.tolerance) {
    return failed(`${where}: total ${actual} does not match sum ${sum} of ${rule.range} (tolerance ${rule.tolerance})`);
  }
}

export async function evaluateSpreadsheet(bytes: Buffer, extension: string, spec: SpreadsheetSpec): Promise<Outcome> {
  const csv = extension === ".csv";
  if (!csv && extension !== ".xlsx") return uncheckable("expected an .xlsx or .csv spreadsheet");
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  try {
    if (csv) {
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (csvExceedsCellLimit(source)) return uncheckable(`spreadsheet exceeds the ${MAX_CELLS}-cell limit`);
      await workbook.csv.read(Readable.from([source]), { sheetName: "CSV", map: (value) => value });
    } else {
      // Merge metadata can expand a tiny XML range into millions of
      // cells. Only stored cell values are relevant to these checks.
      await workbook.xlsx.load(Uint8Array.from(bytes).buffer, { ignoreNodes: ["mergeCells", "hyperlinks"] });
    }
  } catch {
    return uncheckable(`could not parse the file as ${csv ? "UTF-8 CSV" : "XLSX"}`);
  }
  const sheets = workbook.worksheets;
  if (sheets.length > MAX_SHEETS) return uncheckable(`spreadsheet exceeds the ${MAX_SHEETS}-sheet limit`);
  if (!sheets.length) return uncheckable("spreadsheet contains no worksheets");

  let count = 0;
  let populated = false;
  let formulaError: Outcome | undefined;
  let uncached: Outcome | undefined;
  for (const sheet of sheets) {
    if (sheet.rowCount > MAX_ROW || sheet.columnCount > MAX_COLUMN) {
      return uncheckable("spreadsheet exceeds Excel's supported grid dimensions");
    }
    sheet.eachRow((row) => {
      if (count > MAX_CELLS) return;
      row.eachCell((cell) => {
        count++;
        if (count > MAX_CELLS || formulaError) return;
        const value = cellValue(cell);
        if (cell.type === ExcelJS.ValueType.Formula) {
          if (value == null) {
            uncached ??= uncheckable(`${location(sheet, cell.address)}: formula has no cached result`);
          } else if ((value instanceof Date && !Number.isFinite(value.getTime())) ||
                     (typeof value === "number" && !Number.isFinite(value))) {
            uncached ??= uncheckable(`${location(sheet, cell.address)}: formula cached result could not be read`);
          }
        }
        populated ||= value != null && (typeof value !== "string" || !!value.trim());
        if (value && typeof value === "object" && "error" in value) {
          formulaError = failed(`${location(sheet, cell.address)}: ${value.error}`);
        } else if (csv && typeof value === "string" && ERROR_MARKERS.has(value.trim())) {
          formulaError = failed(`${location(sheet, cell.address)}: ${value.trim()}`);
        }
      });
    });
  }
  if (count > MAX_CELLS) return uncheckable(`spreadsheet exceeds the ${MAX_CELLS}-cell limit`);
  if (formulaError) return formulaError;

  const byName = new Map(sheets.map((sheet) => [sheet.name, sheet]));
  for (const name of spec.requiredSheets) {
    if (!byName.has(name)) return failed(`missing worksheet ${JSON.stringify(name)}`);
  }
  if (uncached) return uncached;
  for (const rule of spec.requiredColumns) {
    const sheet = byName.get(rule.sheet);
    if (!sheet) return failed(`missing worksheet ${JSON.stringify(rule.sheet)}`);
    const headers = new Set<string>();
    sheet.findRow(1)?.eachCell((cell) => headers.add(normalizeHeader(headerText(cellValue(cell)))));
    const missing = rule.columns.find((column) => !headers.has(normalizeHeader(column)));
    if (missing) return failed(`worksheet ${JSON.stringify(rule.sheet)} is missing header ${JSON.stringify(missing)} in row 1`);
  }
  for (const rule of spec.totals) {
    const sheet = byName.get(rule.sheet);
    if (!sheet) return failed(`missing worksheet ${JSON.stringify(rule.sheet)}`);
    const failure = totalFailure(sheet, rule, csv);
    if (failure) return failure;
  }
  if (!populated) return uncheckable("spreadsheet contains no populated cells");
  return { status: "pass", detail: `spreadsheet passed (${sheets.length} sheets, ${spec.totals.length} totals reconciled)` };
}
