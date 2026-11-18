import { describe, expect, it } from "vitest";

import { SESSION_ID_MAX_LENGTH, sessionIdError } from "./session-id.js";

describe("sessionIdError", () => {
  it("accepts the ids the runtime and clients use", () => {
    for (const id of ["s-0f8c2b1e-1111-4222-8333-944445555666", "api-0123456789abcdef", "s-w-x", "chat_1.2", "A"]) {
      expect(sessionIdError(id)).toBeNull();
    }
  });

  it("refuses path pieces, separators, controls, empties and long ids", () => {
    for (const id of ["", ".", "..", "../x", "a/b", "a\\b", "-x", ".hidden", "a b", "a\nb", "a\u0000", "a:b", "x".repeat(SESSION_ID_MAX_LENGTH + 1)]) {
      expect(sessionIdError(id), JSON.stringify(id)).not.toBeNull();
    }
    expect(sessionIdError(42)).not.toBeNull();
    expect(sessionIdError("x".repeat(SESSION_ID_MAX_LENGTH))).toBeNull();
  });
});
