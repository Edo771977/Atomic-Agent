import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resetConfigCache } from "../config/index.js";
import { writeExportFile } from "./chat-export-file.js";

vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const deny = (path: unknown) => {
    if (typeof path === "string" && path.includes(".chat-export-")) {
      throw Object.assign(new Error("synthetic temporary creation denied"), { code: "EACCES" });
    }
  };
  return { ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => { deny(args[0]); return fs.openSync(...args); },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => { deny(args[0]); return fs.writeFileSync(...args); },
  };
});

let root = "";
afterEach(() => { resetConfigCache(); vi.unstubAllEnvs(); if (root) rmSync(root, { recursive: true, force: true }); });
it("returns a failure and keeps the destination when an adjacent temporary cannot be created", () => {
  root = mkdtempSync(join(tmpdir(), "export-create-"));
  mkdirSync(join(root, "state"));
  vi.stubEnv("ATOMIC_AGENT_STATE_DIR", join(root, "state"));
  resetConfigCache();
  const path = join(root, "chat.md");
  writeFileSync(path, "original");
  expect(writeExportFile(path, "replacement", true)).toMatch(/creation denied/);
  expect(readFileSync(path, "utf8")).toBe("original");
  expect(readdirSync(root).sort()).toEqual(["chat.md", "state"]);
});

it("documents the 0600 permission transition on forced replacement", () => {
  const guide = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  expect(guide).toMatch(/--force[^\n]*0600/);
  expect(guide).toMatch(/does not copy the previous file mode/);
});
