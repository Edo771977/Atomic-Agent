import { describe, expect, it } from "vitest";

import { dispatchSlashCommand } from "./slash-command-handler.js";

describe("/plan (issue #39)", () => {
  it("asks for the fusion project card in full and clears the buffer", () => {
    expect(dispatchSlashCommand("/plan")).toMatchObject({ projectView: true, clearBuffer: true });
  });
});
