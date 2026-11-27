import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import * as onboarding from "./onboarding-import-step.js";

describe("C3d first-run facts destination remains deferred", () => {
  it("does not export a hint for the unavailable facts workflow", () => {
    expect(onboarding).not.toHaveProperty("CHAT_EXPORT_HINT");
  });
  it("does not advertise the absent facts step from first run", () => {
    const screen = render(<onboarding.OnboardingImportPickStep agents={[]} cursor={0} busy={false} error={null} />);
    try { expect(screen.lastFrame() ?? "").not.toContain("/import › Facts about you"); }
    finally { screen.unmount(); screen.cleanup(); }
  });
});
