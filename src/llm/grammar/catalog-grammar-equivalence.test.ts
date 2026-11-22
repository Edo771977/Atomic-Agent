import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_TOOL_DESCRIPTORS } from "../../prompt/tool-descriptors.js";
import { gbnfAccepts, parseGbnf } from "./gbnf-test-helpers.js";
import { objectRule as historicalObjectRule } from "./fixtures/object-rule-before-5f49e172b.js";
import { convertArgsSchema, RuleTable } from "./json-schema-to-gbnf.js";

const host = readFileSync(new URL("../../../grammars/tool-call.gbnf", import.meta.url), "utf8");
const reserved = new Set(parseGbnf(host).keys());
let historicalConvert: typeof convertArgsSchema;

beforeAll(async () => {
  // The only emitter changed in 5f49e172b was objectRule. Load a second
  // converter with its historical implementation; both receive identical schemas.
  vi.resetModules();
  vi.doMock("./json-schema-gbnf-shapes.js", async (original) => ({
    ...await original<typeof import("./json-schema-gbnf-shapes.js")>(),
    objectRule: historicalObjectRule,
  }));
  try {
    historicalConvert = (await import("./json-schema-to-gbnf.js")).convertArgsSchema;
  } finally {
    vi.doUnmock("./json-schema-gbnf-shapes.js");
  }
});

type Shape = {
  type?: string | string[];
  enum?: unknown[];
  anyOf?: Shape[];
  items?: Shape;
  minItems?: number;
  minimum?: number;
  properties?: Record<string, Shape>;
  required?: string[];
};

function sample(shape: Shape, includeOptional = false): unknown {
  if (shape.enum) return shape.enum[0];
  if (shape.anyOf) return sample(shape.anyOf[0]!, includeOptional);
  const type = Array.isArray(shape.type) ? shape.type[0] : shape.type;
  switch (type) {
    case "object": return sampleArgs(shape, includeOptional);
    case "array": return Array.from({ length: Math.max(1, shape.minItems ?? 0) }, () => sample(shape.items ?? {}, includeOptional));
    case "integer":
    case "number": return shape.minimum ?? 1;
    case "boolean": return true;
    case "null": return null;
    case "string": return "sample";
    case undefined: return "sample"; // unconstrained JSON value
    default: throw new Error("Unsupported catalog schema type: " + type);
  }
}

function sampleArgs(shape: Shape, includeOptional = false): Record<string, unknown> {
  const properties = shape.properties ?? {};
  const keys = includeOptional ? Object.keys(properties) : shape.required ?? [];
  return Object.fromEntries(keys.map(key => [key, sample(properties[key]!, includeOptional)]));
}

function compile(convert: typeof convertArgsSchema, schema: Shape) {
  // Compare the languages directly, independent of production rule caps:
  // a generic-object fallback on either side would invalidate this test.
  const converted = convert(schema, "args", new RuleTable(reserved), { maxRules: Infinity, maxChars: Infinity });
  const emitted = converted.added.map(([name, body]) => name + " ::= " + body).join("\n");
  const rules = parseGbnf(host + "\n" + emitted);
  return {
    emitted,
    accepts: (args: unknown) => gbnfAccepts(rules, converted.rule, JSON.stringify(args)),
  };
}

describe("catalog argument languages before and after 5f49e172b", () => {
  it.each(DEFAULT_TOOL_DESCRIPTORS)("$name", (descriptor) => {
    expect(descriptor.argsJsonSchema).toBeDefined();
    const schema: Shape = descriptor.argsJsonSchema!;
    const before = compile(historicalConvert, schema);
    const after = compile(convertArgsSchema, schema);
    if (descriptor.name === "verify.run") expect(after.emitted).not.toBe(before.emitted);

    function check(args: unknown, expected: boolean, label: string) {
      expect([before.accepts(args), after.accepts(args)], label + ": " + JSON.stringify(args))
        .toEqual([expected, expected]);
    }

    for (const example of descriptor.examples ?? []) {
      check(JSON.parse(example), true, "descriptor example");
    }
    const minimal = sampleArgs(schema);
    check(minimal, true, "all optional fields absent");
    const complete = sampleArgs(schema, true);
    for (const key of Object.keys(complete)) {
      if (Object.hasOwn(minimal, key)) continue;
      check({ ...minimal, [key]: complete[key] }, true, "optional " + key);
    }
    check(complete, true, "all optional fields present");
    check({ ...minimal, unknownFixtureKey: true }, false, "unknown key");
    check([], false, "wrong argument type");
    for (const key of schema.required ?? []) {
      const missing = { ...minimal };
      delete missing[key];
      check(missing, false, "missing " + key);
    }
    for (const [key, field] of Object.entries(schema.properties ?? {})) {
      // All typed/catalog enums reject at least one of these JSON types.
      if (!field.type && !field.enum && !field.anyOf) continue;
      const candidates = [null, true, 42, "wrong", [], {}];
      const types = (field.anyOf ?? [field]).flatMap(branch => branch.type ?? []);
      const wrong = candidates.find(value => {
        if (field.enum) return !field.enum.includes(value);
        const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
        return !types.includes(type) && !(type === "number" && types.includes("integer"));
      });
      if (wrong !== undefined) check({ ...minimal, [key]: wrong }, false, "wrong type for " + key);
    }
  });
});
