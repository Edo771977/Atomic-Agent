import { describe, expect, it } from "vitest";

import { surfaceShowsProjectGates, withProjectToolVisibility } from "./project-surface.js";

describe("project gate surfaces (issue #39)", () => {
  it("the TUI, the CLI and Telegram decide gates", () => {
    expect(surfaceShowsProjectGates({ origin: "tui", answerChannel: "terminal" })).toBe(true);
    expect(surfaceShowsProjectGates({ origin: "cli" })).toBe(true);
    expect(surfaceShowsProjectGates({})).toBe(true);
    expect(surfaceShowsProjectGates({ origin: "telegram" })).toBe(true);
  });

  it("the desktop, a plain HTTP client, Discord and unattended turns do not, unless the client declares it", () => {
    for (const input of [
      { origin: "sidecar", answerChannel: "desktop" },
      { origin: "http", answerChannel: "desktop" },
      { origin: "http" },
      { origin: "discord" },
      { origin: "scheduler" },
      { origin: "fusion" },
    ]) {
      expect(surfaceShowsProjectGates(input), JSON.stringify(input)).toBe(false);
    }
    expect(surfaceShowsProjectGates({ origin: "sidecar", answerChannel: "desktop", projectGates: true })).toBe(true);
    expect(surfaceShowsProjectGates({ origin: "http", projectGates: true })).toBe(true);
  });

  it("hides the project tools, and only them, when the surface cannot decide", () => {
    expect(withProjectToolVisibility(undefined, true)).toBeUndefined();
    const own = (name: string) => name !== "fs.write";
    expect(withProjectToolVisibility(own, true)).toBe(own);
    const hidden = withProjectToolVisibility(own, false)!;
    for (const name of ["project.brief", "project.plan", "project.milestone", "fs.write"]) expect(hidden(name), name).toBe(false);
    expect(hidden("fusion.delegate")).toBe(true);
    expect(withProjectToolVisibility(undefined, false)!("fs.read")).toBe(true);
  });
});
