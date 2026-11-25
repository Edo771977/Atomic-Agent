import { createInflateRaw } from "node:zlib";
import JSZip from "jszip";

const MAX_OFFICE_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_OFFICE_PART_BYTES = 64 * 1024 * 1024;

// JSZip's loaded CompressedObject. Public ZipObject methods only expose
// sizes after inflation. Keep the dependency on its metadata here.
interface CompressedPart {
  uncompressedSize: number;
  compressedContent: Uint8Array;
  compression: { magic: string };
}

type LoadedZipEntry = JSZip.JSZipObject & { _data?: CompressedPart | Promise<Buffer> | "" };

export async function loadBoundedOfficeZip(
  data: Buffer,
  maxBytes = MAX_OFFICE_UNCOMPRESSED_BYTES,
): Promise<JSZip> {
  const zip = await JSZip.loadAsync(data);
  const parts: Array<{ entry: LoadedZipEntry; part: CompressedPart }> = [];
  const limit = Math.min(maxBytes, MAX_OFFICE_UNCOMPRESSED_BYTES);
  let bytes = 0;
  for (const entry of Object.values(zip.files) as LoadedZipEntry[]) {
    if (entry.dir) continue;
    const part = entry._data;
    if (part === "") continue; // JSZip canonicalizes empty entries.
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
  // Central-directory sizes are claims. Count actual bytes as they arrive,
  // and keep the verified chunks as each entry's content so reads reuse them.
  for (const { entry, part } of parts) {
    try {
      entry._data = Promise.resolve(await readBoundedPart(part));
    } catch {
      throw new Error(`Office package part ${JSON.stringify(entry.name)} exceeds or does not match its uncompressed size`);
    }
  }
  return zip;
}

async function readBoundedPart(part: CompressedPart): Promise<Buffer> {
  const { compressedContent, uncompressedSize } = part;
  if (part.compression.magic === "\x00\x00") {
    if (compressedContent.byteLength !== uncompressedSize) throw new Error("size mismatch");
    return Buffer.from(compressedContent.buffer, compressedContent.byteOffset, compressedContent.byteLength);
  }
  const inflater = createInflateRaw();
  inflater.end(compressedContent);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of inflater as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > uncompressedSize) throw new Error("size mismatch");
    chunks.push(chunk);
  }
  if (bytes !== uncompressedSize) throw new Error("size mismatch");
  return Buffer.concat(chunks, bytes);
}
