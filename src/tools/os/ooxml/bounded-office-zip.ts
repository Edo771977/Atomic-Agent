import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";
import JSZip from "jszip";

const MAX_OFFICE_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const inflate = promisify(inflateRaw);

// JSZip's loaded CompressedObject. Public ZipObject methods only expose
// sizes after inflation. Keep the dependency on its metadata here.
interface CompressedPart {
  uncompressedSize: number;
  compressedContent: Uint8Array;
  compression: { magic: string };
}

export async function loadBoundedOfficeZip(
  data: Buffer,
  maxBytes = MAX_OFFICE_UNCOMPRESSED_BYTES,
): Promise<JSZip> {
  const zip = await JSZip.loadAsync(data);
  const parts: Array<{ name: string; part: CompressedPart }> = [];
  let bytes = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const part = (entry as JSZip.JSZipObject & { _data?: CompressedPart | "" })._data;
    if (part === "") continue; // JSZip canonicalizes empty entries.
    if (!part || !Number.isSafeInteger(part.uncompressedSize) || part.uncompressedSize < 0 ||
        !(part.compressedContent instanceof Uint8Array)) {
      throw new Error("Office package has invalid ZIP size information");
    }
    bytes += part.uncompressedSize;
    if (bytes > maxBytes) throw new Error("Office package exceeds the uncompressed size limit (" + maxBytes + " bytes)");
    parts.push({ name: entry.name, part });
  }
  // Central-directory sizes are claims, not limits. Verify with native
  // inflation capped per part before JSZip or ExcelJS opens any XML.
  for (const { name, part } of parts) {
    const { compressedContent, uncompressedSize } = part;
    try {
      const actual = part.compression.magic === "\x00\x00"
        ? compressedContent.byteLength
        : (await inflate(compressedContent, { maxOutputLength: Math.max(1, uncompressedSize) })).byteLength;
      if (actual !== uncompressedSize) throw new Error("size mismatch");
    } catch {
      throw new Error("Office package part " + JSON.stringify(name) + " exceeds or does not match its uncompressed size");
    }
  }
  return zip;
}
