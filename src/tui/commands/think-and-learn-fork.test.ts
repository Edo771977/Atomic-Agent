import { expect, it } from "vitest";
import { dispatchSlashCommand } from "./slash-command-handler.js";

it("routes think while retaining the fork's learned-skill confirmation commands", () => {
  const think = dispatchSlashCommand("/think medium");
  expect(think.reasoningLevel).toBe("medium");
  expect(think.learnCommand).toBeUndefined();
  expect(think.forwardAsMessage).toBe(false);
  expect(dispatchSlashCommand("/learn approve abcd").learnCommand).toMatchObject({ kind: "error" });
  expect(dispatchSlashCommand("/learn confirm 0123456789abcdef").learnCommand)
    .toEqual({ kind: "confirm", confirmation: "0123456789abcdef" });
});
