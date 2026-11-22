import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ENV_DEFAULTS } from "./config-schema.js";
import { envOverrideFor, ENV_SETTINGS, INTERNAL_ENV_NAMES } from "./env-settings.js";

const SRC = fileURLToPath(new URL("../", import.meta.url));

/** Every non-test `.ts` file under `src/`, except the table itself. */
function productionSources(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionSources(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !path.endsWith("env-settings.ts")) out.push(path);
  }
  return out;
}

const NAME = String.raw`(ATOMIC_AGENT_[A-Z0-9_]+)`;

/**
 * The ways production code looks a variable up: a member of something
 * called `env` (`process.env.X`, `options.env.X`, `env["X"]`), a name
 * passed to load-config's readers (`readEnv("X")`, `readInt(\n "X", …)`,
 * `resolveAssetDir("X", …)`), or a `*_ENV` constant that names it. Plain
 * string literals are not enough: error codes such as
 * `ATOMIC_AGENT_PROVIDER_NOT_ALLOWED` share the prefix and are no variable.
 */
const ENV_LOOKUPS: readonly RegExp[] = [
  new RegExp(String.raw`\benv\??\.${NAME}\b`, "g"),
  new RegExp(String.raw`\benv\[\s*["'\x60]${NAME}["'\x60]\s*\]`, "g"),
  new RegExp(String.raw`\b(?:read[A-Z]\w*|resolveAssetDir)\(\s*"${NAME}"`, "g"),
  new RegExp(String.raw`\b[A-Z0-9_]*_ENV\s*(?::[^=]+)?=\s*"${NAME}"`, "g"),
];

/** Source text without block comments and `//` comment lines. */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Variables the code reads from the environment. */
function namesReadByTheCode(): Set<string> {
  const names = new Set<string>();
  for (const file of productionSources()) {
    const code = codeOf(file);
    for (const pattern of ENV_LOOKUPS) {
      for (const match of code.matchAll(pattern)) names.add(match[1]!);
    }
  }
  return names;
}

/** Every `ATOMIC_AGENT_*` name the code still mentions in a string, for the staleness check. */
function namesMentionedByTheCode(): Set<string> {
  const names = new Set<string>();
  for (const file of productionSources()) {
    for (const match of readFileSync(file, "utf8").matchAll(/["'.\x60](ATOMIC_AGENT_[A-Z0-9_]+)/g)) names.add(match[1]!);
  }
  return names;
}

describe("the env-variable scan", () => {
  it("counts only environment lookups, not error codes that share the prefix", () => {
    const read = namesReadByTheCode();
    for (const code of [
      "ATOMIC_AGENT_PROVIDER_NOT_ALLOWED",
      "ATOMIC_AGENT_CHANNEL_RESTRICTED",
      "ATOMIC_AGENT_EGRESS_NOT_ALLOWED",
      "ATOMIC_AGENT_WRITE_OUT_NOT_ALLOWED",
    ]) {
      expect(read.has(code), code).toBe(false);
    }
  });

  it("sees variables read as process.env members and through *_ENV constants", () => {
    const read = namesReadByTheCode();
    for (const name of [
      "ATOMIC_AGENT_TREE_SITTER_DIR",
      "ATOMIC_AGENT_STARTER_SKILLS_DIR",
      "ATOMIC_AGENT_OFFLINE",
      "ATOMIC_AGENT_ALLOWED_ORIGINS",
      "ATOMIC_AGENT_LLAMA_HEALTH_TIMEOUT_MS",
    ]) {
      expect(read.has(name), name).toBe(true);
    }
  });
});

describe("ENV_SETTINGS", () => {
  const documented = new Set(ENV_SETTINGS.map((setting) => setting.name));

  it("lists each variable once", () => {
    expect(documented.size).toBe(ENV_SETTINGS.length);
  });

  it("documents every ATOMIC_AGENT_* variable the code reads, or names it internal", () => {
    const missing = [...namesReadByTheCode()].filter((name) => !documented.has(name) && !INTERNAL_ENV_NAMES.has(name));
    expect(missing, "add them to ENV_SETTINGS (or INTERNAL_ENV_NAMES) in src/config/env-settings.ts").toEqual([]);
  });

  it("has no entry the code no longer reads", () => {
    const read = namesMentionedByTheCode();
    const stale = [...documented, ...INTERNAL_ENV_NAMES.keys()].filter(
      (name) => name.startsWith("ATOMIC_AGENT_") && !read.has(name),
    );
    expect(stale).toEqual([]);
  });

  it("takes defaults from ENV_DEFAULTS rather than restating them", () => {
    const byName = new Map(ENV_SETTINGS.map((setting) => [setting.name, setting.default]));
    expect(byName.get("ATOMIC_AGENT_STATE_DIR")).toBe(ENV_DEFAULTS.STATE_DIR);
    expect(byName.get("ATOMIC_AGENT_MAX_PARALLEL_TOOL_CALLS")).toBe(ENV_DEFAULTS.MAX_PARALLEL_TOOL_CALLS);
    expect(byName.get("ATOMIC_AGENT_TASKS_SCHEDULER_TICK_MS")).toBe(ENV_DEFAULTS.TASKS_SCHEDULER_TICK_MS);
  });

  it("names the config key each override wins over", () => {
    expect(envOverrideFor("localModels.completionMaxTokens")).toBe("ATOMIC_AGENT_LLAMA_MAX_TOKENS");
    expect(envOverrideFor("localModels.requestTimeoutMs")).toBe("ATOMIC_AGENT_LLAMA_REQUEST_TIMEOUT_MS");
    expect(envOverrideFor("skills.catalogTokenBudget")).toBe("ATOMIC_AGENT_SKILLS_CATALOG_BUDGET");
    expect(envOverrideFor("browser.cdpUrl")).toBe("ATOMIC_AGENT_BROWSER_CDP_URL");
    expect(envOverrideFor("agent.maxSteps")).toBeNull();
  });
});
