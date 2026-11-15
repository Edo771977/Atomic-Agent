import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_OFFICIAL_PRICES_DATE,
  ANTHROPIC_OFFICIAL_PRICES_STALE_DAYS,
  anthropicOfficialPricesStaleNote,
} from "./anthropic-official-prices.js";

const DAY = 24 * 60 * 60 * 1000;

describe("anthropicOfficialPricesStaleNote", () => {
  const listed = Date.parse("2026-11-15T00:00:00Z");

  it("is silent up to 90 days after the list date", () => {
    expect(ANTHROPIC_OFFICIAL_PRICES_STALE_DAYS).toBe(90);
    expect(anthropicOfficialPricesStaleNote(listed, "2026-11-15")).toBeUndefined();
    expect(anthropicOfficialPricesStaleNote(listed + 90 * DAY, "2026-11-15")).toBeUndefined();
  });

  it("names the date and the official pricing page once the list is older", () => {
    const note = anthropicOfficialPricesStaleNote(listed + 90 * DAY + 1, "2026-11-15");
    expect(note).toBe(
      "(price list from 2026-11-15; check https://platform.claude.com/docs/en/about-claude/pricing)",
    );
    // A packaged install has no source checkout to run an npm script in.
    expect(note).not.toContain("npm run");
  });

  it("defaults to the committed table's date", () => {
    const committed = Date.parse(`${ANTHROPIC_OFFICIAL_PRICES_DATE}T00:00:00Z`);
    expect(anthropicOfficialPricesStaleNote(committed)).toBeUndefined();
    expect(anthropicOfficialPricesStaleNote(committed + 365 * DAY)).toContain(ANTHROPIC_OFFICIAL_PRICES_DATE);
  });

  it("stays silent on an unreadable date rather than guessing", () => {
    expect(anthropicOfficialPricesStaleNote(listed, "not-a-date")).toBeUndefined();
  });
});
