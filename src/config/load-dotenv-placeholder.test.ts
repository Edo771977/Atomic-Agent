import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadDotenvFromStateDir } from "./load-dotenv.js";

const REAL = "sk-ant-api03-real-looking-key-0123456789";

describe("a placeholder key in the shell does not hide the one in .env", () => {
  let dir: string;
  let stderr: string[];
  let originalWrite: typeof process.stderr.write;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-dotenv-ph-"));
    stderr = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    for (const k of ["ANTHROPIC_API_KEY", "ATOMIC_DOTENV_PH_SETTING"]) saved.set(k, process.env[k]);
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("uses the .env key and warns once, naming only the length", () => {
    process.env.ANTHROPIC_API_KEY = "...";
    writeFileSync(join(dir, ".env"), `ANTHROPIC_API_KEY=${REAL}\n`, "utf8");
    const result = loadDotenvFromStateDir(dir);
    expect(process.env.ANTHROPIC_API_KEY).toBe(REAL);
    expect(result.replacedPlaceholders).toEqual(["ANTHROPIC_API_KEY"]);
    const text = stderr.join("");
    expect(text).toContain("ANTHROPIC_API_KEY in the environment looks like a placeholder (3 characters); using the value from .env");
    expect(text).not.toContain(REAL);
    // A second load (the config cache reset) does not warn again.
    stderr.length = 0;
    loadDotenvFromStateDir(dir);
    expect(stderr.join("")).toBe("");
  });

  it("a too-short cloud key in the shell yields to a well-formed .env key", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-x";
    writeFileSync(join(dir, ".env"), `ANTHROPIC_API_KEY=${REAL}\n`, "utf8");
    loadDotenvFromStateDir(dir);
    expect(process.env.ANTHROPIC_API_KEY).toBe(REAL);
  });

  it("keeps the shell value when it looks real, or when .env holds a placeholder too", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-another-real-key-9876543210";
    writeFileSync(join(dir, ".env"), `ANTHROPIC_API_KEY=${REAL}\n`, "utf8");
    loadDotenvFromStateDir(dir);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-another-real-key-9876543210");
    process.env.ANTHROPIC_API_KEY = "...";
    writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=<key>\n", "utf8");
    loadDotenvFromStateDir(dir);
    expect(process.env.ANTHROPIC_API_KEY).toBe("...");
  });

  it("never touches a non-secret variable the shell set", () => {
    process.env.ATOMIC_DOTENV_PH_SETTING = "...";
    writeFileSync(join(dir, ".env"), "ATOMIC_DOTENV_PH_SETTING=file\n", "utf8");
    loadDotenvFromStateDir(dir);
    expect(process.env.ATOMIC_DOTENV_PH_SETTING).toBe("...");
  });
});
