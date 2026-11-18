import { describe, expect, it } from "vitest";

import { CLAUDE_APP_SESSION_ID_PREFIX } from "../import/claude-app/map-session.js";
import { CLAUDE_CODE_SESSION_ID_PREFIX } from "../import/claude-code/map-session.js";
import { CODEX_SESSION_ID_PREFIX } from "../import/codex/map-session.js";
import { HERMES_SESSION_ID_PREFIX } from "../import/hermes/map-session.js";
import { OH_MY_PI_SESSION_ID_PREFIX } from "../import/oh-my-pi/map-session.js";
import { OPENCLAW_SESSION_ID_PREFIX } from "../import/openclaw/map-session.js";
import { PI_SESSION_ID_PREFIX } from "../import/pi/map-session.js";

import { SESSION_ID_MAX_LENGTH, sessionFileName, sessionIdError, sessionIdFromFileName } from "./session-id.js";

/**
 * Every id the store legitimately holds: the runtime's own and each
 * importer's prefix plus a source id of the shape that tool writes.
 */
const STORED_IDS = [
  "s-0f8c2b1e-1111-4222-8333-944445555666",
  "s-w-0f8c2b1e-1111-4222-8333-944445555666",
  "api-0123456789abcdef",
  `${CLAUDE_CODE_SESSION_ID_PREFIX}6f1d0c3a-9b7e-4a52-8c1d-2e3f4a5b6c7d`,
  `${CODEX_SESSION_ID_PREFIX}2025-03-05T09-15-23-0195a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b`,
  `${CLAUDE_APP_SESSION_ID_PREFIX}0b6e9f2a-1c3d-4e5f-a6b7-c8d9e0f1a2b3`,
  `${HERMES_SESSION_ID_PREFIX}20250305_091523_a1b2c3`,
  `${PI_SESSION_ID_PREFIX}1741166123456_9f8e7d6c`,
  `${OH_MY_PI_SESSION_ID_PREFIX}c0ffee12-3456-7890-abcd-ef0123456789`,
  `${OPENCLAW_SESSION_ID_PREFIX}6f1d0c3a-9b7e-4a52-8c1d-2e3f4a5b6c7d`,
  `${OPENCLAW_SESSION_ID_PREFIX}research agent:sess-0`,
  "chat_1.2",
  "A",
];

describe("sessionIdError", () => {
  it.each(STORED_IDS)("accepts the stored id %s", (id) => {
    expect(sessionIdError(id)).toBeNull();
  });

  it("refuses path pieces, separators, controls, empties and long ids", () => {
    for (const id of ["", ".", "..", "../x", "a..b", "a/b", "a\\b", ".hidden", "a\nb", "a\rb", "a\u0000", "a\tb", "a\u007f", "x".repeat(SESSION_ID_MAX_LENGTH + 1)]) {
      expect(sessionIdError(id), JSON.stringify(id)).not.toBeNull();
    }
    expect(sessionIdError(42)).not.toBeNull();
    expect(sessionIdError("x".repeat(SESSION_ID_MAX_LENGTH))).toBeNull();
  });
});

describe("sessionFileName", () => {
  it("keeps a plain id as it is (existing files keep their names)", () => {
    expect(sessionFileName("s-0f8c2b1e-1111")).toBe("s-0f8c2b1e-1111");
    expect(sessionFileName("api-0123.x_y")).toBe("api-0123.x_y");
  });

  it("never lets ':' or a separator through, and stays stable", () => {
    for (const id of [...STORED_IDS, "a/b", "..\\x", "../../x", ".hidden", "compaction:s-1", "é😀"]) {
      const name = sessionFileName(id);
      expect(name, id).toMatch(/^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/);
      expect(name.length, id).toBeLessThanOrEqual(200);
      expect(sessionFileName(id)).toBe(name);
    }
  });

  it("is collision-free across ids that a lossy replacement would merge", () => {
    const ids = ["a:b", "a_b", "a~3ab", "a~b", "a/b", "a%3ab", ".a", "~2ea", "x".repeat(300), `${"x".repeat(299)}y`];
    const names = ids.map(sessionFileName);
    expect(new Set(names).size).toBe(ids.length);
  });
});

describe("sessionIdFromFileName", () => {
  it("reads back every escaped name, and a raw legacy name as it is", () => {
    for (const id of ["s-1", "claude-code:6f1d", "a~b", ".hidden", "é😀", "openclaw:research agent:sess-0"]) {
      expect(sessionIdFromFileName(sessionFileName(id))).toBe(id);
    }
    expect(sessionIdFromFileName("codex:abc")).toBe("codex:abc");
    // A raw name an older build wrote, holding '~xx' that sessionFileName would never produce.
    expect(sessionIdFromFileName("a~3ab~zz")).toBe("a~3ab~zz");
    expect(sessionIdFromFileName("a~41b")).toBe("a~41b");
    expect(sessionIdFromFileName("a~3Ab")).toBe("a~3Ab");
    expect(sessionIdFromFileName(sessionFileName("x".repeat(300)))).toBeNull();
  });
});
