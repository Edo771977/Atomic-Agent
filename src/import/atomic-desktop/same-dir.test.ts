import { describe, expect, it, vi } from "vitest";

/**
 * Windows NTFS file ids are 64-bit. Read as a JS number they lose
 * precision past 2^53, so two different folders could share an `ino` and
 * the importer refused a real source as "the target state dir" (seen on
 * the Windows CI gate). The comparison must use the exact (bigint) ids.
 */
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    statSync: (path: string, options?: { bigint?: boolean }) => {
      // As a lossy number the two ids collide; as bigints they differ.
      if (options?.bigint) return { dev: 7n, ino: path.endsWith("a") ? 18446744073709551000n : 18446744073709551001n };
      return { dev: 7, ino: 18446744073709552000 };
    },
    realpathSync: (path: string) => path,
  };
});

const { sameDir } = await import("./atomic-desktop-importer.js");

describe("sameDir", () => {
  it("tells two folders apart when their 64-bit file ids differ only past 2^53", () => {
    expect(sameDir("/tmp/x/a", "/tmp/x/b")).toBe(false);
  });
  it("still matches one folder by its exact file id", () => {
    expect(sameDir("/tmp/x/a", "/tmp/x/A-other-spelling-a")).toBe(true);
  });
});
