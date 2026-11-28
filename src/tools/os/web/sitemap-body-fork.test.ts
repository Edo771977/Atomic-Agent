import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { decodeSitemapBody } from "./sitemap-body.js";

describe("B7b1 decompressed sitemap budget", () => {
  it("rejects a gzip bomb by decompressed bytes", () => {
    const bytes = gzipSync("x".repeat(3_000_000));
    expect(bytes.length).toBeLessThan(10_000);
    expect(decodeSitemapBody({ bytes, body: "" }).ok).toBe(false);
  });
  it("bounds both layers when a gzip file is gzip-encoded again", () => {
    expect(decodeSitemapBody({ bytes: gzipSync(gzipSync("x".repeat(3_000_000))), body: "" }).ok).toBe(false);
  });
  it("reads a large uncompressed sitemap only up to 2 MB in bytes", () => {
    const decoded = decodeSitemapBody({ body: "é".repeat(1_500_000) });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(Buffer.byteLength(decoded.xml)).toBeLessThanOrEqual(2_000_000);
  });
});
