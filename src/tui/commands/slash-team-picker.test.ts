import { describe, expect, it } from "vitest";

import { dispatchSlashCommand } from "./slash-command-handler.js";
import { resolveSlashCommand } from "./slash-commands.js";

/** Issue #37: `/director` and a bare `/worker` open the open chat's fusion team pickers. */
describe("fusion team picker commands", () => {
  it("/director opens the director picker", () => {
    expect(resolveSlashCommand("director")?.name).toBe("director");
    expect(dispatchSlashCommand("/director")).toMatchObject({ teamPicker: "director", clearBuffer: true });
  });

  it("a bare /worker opens the preferred-worker picker; its verbs are unchanged", () => {
    expect(dispatchSlashCommand("/worker")).toMatchObject({ teamPicker: "worker" });
    expect(dispatchSlashCommand("/worker stop w1").teamPicker).toBeUndefined();
    expect(dispatchSlashCommand("/worker bogus").systemMessage).toMatch(/usage: \/worker/);
  });
});
