import { describe, expect, it } from "vitest";
import { parseUserConfigFile, USER_CONFIG_VERSION } from "./config-schema.js";
import { setConfigNoticeSink } from "./config-primitives.js";
import { ConfigValidationError } from "./config-validation-error.js";
import { parseProjectConstraints } from "./project-constraints-config.js";

describe("projects.constraints parsing", () => {
  it("reads absolute folders with their allowed provider ids", () => {
    expect(parseProjectConstraints({ "/work/client": { allowedProviders: ["local-llama"] } }, { platform: "linux" }))
      .toEqual({ "/work/client": { allowedProviders: ["local-llama"] } });
  });

  it("is empty when absent or null", () => {
    expect(parseProjectConstraints(undefined, { platform: "linux" })).toEqual({});
    expect(parseProjectConstraints(null, { platform: "linux" })).toEqual({});
  });

  it.each([
    ["a list", []],
    ["a string", "/work"],
    ["a relative folder", { "work/client": { allowedProviders: ["local-llama"] } }],
    ["an empty folder", { "": { allowedProviders: ["local-llama"] } }],
    ["an entry that is not an object", { "/work": ["local-llama"] }],
    ["an entry without allowedProviders", { "/work": {} }],
    ["allowedProviders not a list", { "/work": { allowedProviders: "local-llama" } }],
    ["an empty provider id", { "/work": { allowedProviders: [""] } }],
    ["a provider id that is not a string", { "/work": { allowedProviders: [7] } }],
  ])("rejects %s (fail closed)", (_label, raw) => {
    expect(() => parseProjectConstraints(raw, { platform: "linux" })).toThrow(ConfigValidationError);
  });

  it("accepts Windows drive and UNC folders on Windows", () => {
    expect(parseProjectConstraints({
      "C:\\Work\\Client": { allowedProviders: ["local-llama"] },
      "\\\\server\\share\\x": { allowedProviders: [] },
    }, { platform: "win32" })).toEqual({
      "C:\\Work\\Client": { allowedProviders: ["local-llama"] },
      "\\\\server\\share\\x": { allowedProviders: [] },
    });
  });

  it("keeps an unknown provider id with a notice; it simply never matches", () => {
    const lines: string[] = [];
    setConfigNoticeSink((line) => lines.push(line));
    try {
      const parsed = parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        projects: { constraints: { "/work/nobody-has-this": { allowedProviders: ["no-such-provider"] } } },
      });
      expect(parsed.projects.constraints["/work/nobody-has-this"]?.allowedProviders).toEqual(["no-such-provider"]);
      expect(lines.some((l) => l.includes("no-such-provider"))).toBe(true);
    } finally {
      setConfigNoticeSink(null);
    }
  });

  it("rejects a malformed block in the whole file", () => {
    expect(() => parseUserConfigFile({
      version: USER_CONFIG_VERSION,
      projects: { constraints: { "relative/dir": { allowedProviders: ["local-llama"] } } },
    })).toThrow(/projects\.constraints/);
  });

  it("migrates a v79 file to v80 keeping projects.roots and adding no constraint", () => {
    const parsed = parseUserConfigFile({ version: 79, projects: { roots: ["/data/projects"] } });
    expect(USER_CONFIG_VERSION).toBe(80);
    expect(parsed.version).toBe(80);
    expect(parsed.projects).toEqual({ roots: ["/data/projects"], constraints: {} });
  });

  it("ignores unknown keys inside an entry (a newer build may add some)", () => {
    expect(parseProjectConstraints({ "/w": { allowedProviders: ["a"], allowedEgress: ["x"] } }, { platform: "linux" }))
      .toEqual({ "/w": { allowedProviders: ["a"] } });
  });
});
