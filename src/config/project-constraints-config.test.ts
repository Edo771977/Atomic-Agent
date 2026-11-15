import { describe, expect, it } from "vitest";
import { parseUserConfigFile, USER_CONFIG_VERSION } from "./config-schema.js";
import { setConfigNoticeSink } from "./config-primitives.js";
import { ConfigValidationError } from "./config-validation-error.js";
import { parseProjectConstraints, projectConstraintNotices } from "./project-constraints-config.js";

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

  it("fails closed on a misspelt allowedProviders, naming the key it got", () => {
    expect(() => parseProjectConstraints({ "/w": { allowedProvider: ["local-llama"] } }, { platform: "linux" }))
      .toThrow(ConfigValidationError);
    expect(() => parseProjectConstraints({ "/w": { allowedProvider: ["local-llama"] } }, { platform: "linux" }))
      .toThrow(/did you mean "allowedProviders" \(got "allowedProvider"\)/);
  });

  it("reads allowedEgress classes, mcp:<server> included", () => {
    expect(parseProjectConstraints({ "/w": { allowedProviders: [], allowedEgress: ["web", "mcp:docs", "web"] } }, { platform: "linux" }))
      .toEqual({ "/w": { allowedProviders: [], allowedEgress: ["web", "mcp:docs"] } });
  });

  it.each([
    ["not a list", "web"],
    ["an unknown class", ["internet"]],
    ["an empty mcp server", ["mcp:"]],
    ["a non-string", [3]],
  ])("rejects allowedEgress that is %s (fail closed)", (_label, allowedEgress) => {
    expect(() => parseProjectConstraints({ "/w": { allowedProviders: [], allowedEgress } }, { platform: "linux" }))
      .toThrow(ConfigValidationError);
  });

  it("names the known egress classes when one is unknown", () => {
    expect(() => parseProjectConstraints({ "/w": { allowedProviders: [], allowedEgress: ["webb"] } }, { platform: "linux" }))
      .toThrow(/"webb".*web, http, browser/);
  });

  it("suggests allowedEgress for a near miss", () => {
    expect(projectConstraintNotices({ "/w": { allowedProviders: [], allowedEgres: ["web"] } }, []))
      .toEqual([expect.stringMatching(/unknown key "allowedEgres" \(ignored\); did you mean "allowedEgress"\?/)]);
  });

  it("drops an unknown key inside an entry from the parsed value", () => {
    expect(parseProjectConstraints({ "/w": { allowedProviders: ["a"], colour: "red" } }, { platform: "linux" }))
      .toEqual({ "/w": { allowedProviders: ["a"] } });
  });

  it("warns about an unknown key inside an entry, suggesting the closest known key", () => {
    const notices = projectConstraintNotices(
      { "/w": { allowedProviders: ["local-llama"], allowedProvidres: ["x"], colour: "red" } },
      ["local-llama"],
    );
    expect(notices).toEqual([
      expect.stringMatching(/projects\.constraints\["\/w"\] has unknown key "allowedProvidres" \(ignored\); did you mean "allowedProviders"\?/),
      expect.stringMatching(/projects\.constraints\["\/w"\] has unknown key "colour" \(ignored\)$/),
    ]);
  });

  it("surfaces the unknown-key warning as a config notice when the whole file loads", () => {
    const lines: string[] = [];
    setConfigNoticeSink((line) => lines.push(line));
    try {
      parseUserConfigFile({
        version: USER_CONFIG_VERSION,
        projects: { constraints: { "/work/typo-notice": { allowedProviders: ["local-llama"], allowedProvidrs: [] } } },
      });
      expect(lines.some((l) => l.includes("\"allowedProvidrs\"") && l.includes("did you mean \"allowedProviders\""))).toBe(true);
    } finally {
      setConfigNoticeSink(null);
    }
  });
});
