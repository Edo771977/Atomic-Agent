import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { withDeclaredOfficePartSize } from "../../office/office-zip-fixture.js";
import { docxExtractor } from "./docx-extractor.js";
import { pptxExtractor } from "./pptx-extractor.js";
import { xlsxExtractor } from "./xlsx-extractor.js";

it.each([
  ["docx", docxExtractor], ["pptx", pptxExtractor], ["xlsx", xlsxExtractor],
] as const)("bounds the existing %s archive before extraction", async (format, extract) => {
  const source = new URL(`../../test-fixtures/sample.${format}`, import.meta.url);
  const data = await withDeclaredOfficePartSize(await readFile(source), 257 * 1024 * 1024);
  await expect(extract({ data, sourcePath: `fixture.${format}` })).rejects.toThrow(/uncompressed size limit/);
});
