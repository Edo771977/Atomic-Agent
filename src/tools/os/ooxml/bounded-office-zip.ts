import { createInflateRaw } from "node:zlib";
import JSZip from "jszip";

const MAX_OFFICE_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_OFFICE_PART_BYTES = 64 * 1024 * 1024;
const MARKUP_PART = /\.(?:xml|rels|xhtml|html?|opf|ncx|vml)$/i;

// JSZip's loaded CompressedObject. Public ZipObject methods only expose
// sizes after inflation. Keep the dependency on its metadata here.
interface CompressedPart {
  uncompressedSize: number;
  compressedContent: Uint8Array;
  compression: { magic: string };
}

type LoadedZipEntry = JSZip.JSZipObject & {
  _data?: CompressedPart | Promise<Buffer> | "";
  options: { compression: "STORE" | "DEFLATE" | null };
};

export async function loadBoundedOfficeZip(
  data: Buffer,
  maxBytes = MAX_OFFICE_UNCOMPRESSED_BYTES,
  partSizes?: Map<string, number>,
): Promise<JSZip> {
  const zip = await JSZip.loadAsync(data);
  const parts: Array<{ entry: LoadedZipEntry; part: CompressedPart }> = [];
  const limit = Math.min(maxBytes, MAX_OFFICE_UNCOMPRESSED_BYTES);
  let bytes = 0;
  for (const entry of Object.values(zip.files) as LoadedZipEntry[]) {
    if (entry.dir) continue;
    const part = entry._data;
    if (part === "") {
      partSizes?.set(entry.name, 0);
      continue; // JSZip canonicalizes empty entries.
    }
    if (!part || part instanceof Promise || !Number.isSafeInteger(part.uncompressedSize) || part.uncompressedSize < 0 ||
        !(part.compressedContent instanceof Uint8Array)) {
      throw new Error("Office package has invalid ZIP size information");
    }
    bytes += part.uncompressedSize;
    if (bytes > limit) throw new Error("Office package exceeds the uncompressed size limit (" + limit + " bytes)");
    parts.push({ entry, part });
  }
  for (const { entry, part } of parts) {
    if (part.uncompressedSize > MAX_OFFICE_PART_BYTES) {
      throw new Error(`Office package part ${JSON.stringify(entry.name)} exceeds the per-part size limit (${MAX_OFFICE_PART_BYTES} bytes)`);
    }
  }
  // The sizes in the directory are claims. Validate every entry, but
  // retain decoded bytes only for markup, which the readers will parse.
  for (const { entry, part } of parts) {
    try {
      const chunks: Buffer[] | undefined = MARKUP_PART.test(entry.name) ? [] : undefined;
      await readBoundedPart(part, chunks);
      if (chunks) {
        entry._data = Promise.resolve(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, part.uncompressedSize));
      } else {
        // JSZip can copy the validated stream verbatim when generating a ZIP for
        // ExcelJS or Mammoth, including when the top-level default is STORE.
        entry.options.compression = part.compression.magic === "\x00\x00" ? "STORE" : "DEFLATE";
      }
    } catch {
      throw new Error(`Office package part ${JSON.stringify(entry.name)} exceeds or does not match its uncompressed size`);
    }
    partSizes?.set(entry.name, part.uncompressedSize);
  }
  return zip;
}

async function readBoundedPart(part: CompressedPart, chunks?: Buffer[]): Promise<void> {
  const { compressedContent, uncompressedSize } = part;
  if (part.compression.magic === "\x00\x00") {
    if (compressedContent.byteLength !== uncompressedSize) throw new Error("size mismatch");
    chunks?.push(Buffer.from(compressedContent.buffer, compressedContent.byteOffset, compressedContent.byteLength));
    return;
  }
  const inflater = createInflateRaw();
  inflater.end(compressedContent);
  let bytes = 0;
  for await (const chunk of inflater as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > uncompressedSize) throw new Error("size mismatch");
    chunks?.push(chunk);
  }
  if (bytes !== uncompressedSize) throw new Error("size mismatch");
}
