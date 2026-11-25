import { expect, it } from "vitest";
import JSZip from "jszip";
import { withDeclaredOfficePartSize } from "../../office/office-zip-fixture.js";
import { epubExtractor } from "./epub-extractor.js";
import { odpExtractor } from "./odp-extractor.js";
import { odsExtractor } from "./ods-extractor.js";
import { odtExtractor } from "./odt-extractor.js";

it.each([
  ["odt", odtExtractor], ["ods", odsExtractor], ["odp", odpExtractor], ["epub", epubExtractor],
] as const)("bounds oversized parts in %s before parsing the package", async (format, extract) => {
  const data = await withDeclaredOfficePartSize(await new JSZip().generateAsync({ type: "nodebuffer" }), 200 * 1024 * 1024);
  await expect(extract({ data, sourcePath: `fixture.${format}` })).rejects.toThrow(/per-part size limit.*67108864/);
});
