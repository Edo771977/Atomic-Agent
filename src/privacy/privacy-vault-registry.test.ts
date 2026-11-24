import { afterEach, describe, expect, it } from "vitest";

import {
  forgetPrivacyVault,
  isPrivacyShieldEnabled,
  isPrivacyShieldEnabledForRequest,
  redactPrivacyEvidence,
  withPrivacyShieldTurn,
  linkPrivacyVault,
  privacyShieldTotals,
  privacyVaultFor,
  pinPrivacyVault,
  resetPrivacyVaults,
  setPrivacyKnownSecrets,
  setPrivacyShieldEnabled,
} from "./privacy-vault-registry.js";

afterEach(() => resetPrivacyVaults());

describe("privacy vault registry (ATO-599)", () => {
  it("keeps one vault per session, and isolates requests without an id", () => {
    expect(privacyVaultFor("s1")).toBe(privacyVaultFor("s1"));
    expect(privacyVaultFor("s1")).not.toBe(privacyVaultFor("s2"));
    expect(privacyVaultFor(undefined)).not.toBe(privacyVaultFor(""));
    privacyVaultFor(undefined).mask("isolated@example.test");
    expect(privacyVaultFor(undefined).unmask("[EMAIL_1]")).toBe("[EMAIL_1]");
  });

  it("numbers placeholders per session", () => {
    expect(privacyVaultFor("s1").mask("a@b.io")).toBe("[EMAIL_1]");
    expect(privacyVaultFor("s2").mask("c@d.io")).toBe("[EMAIL_1]");
    expect(privacyVaultFor("s2").unmask("[EMAIL_1]")).toBe("c@d.io");
  });

  it("sums the masked-N totals and forgets a deleted session", () => {
    privacyVaultFor("s1").mask("a@b.io c@d.io");
    privacyVaultFor("s2").mask("e@f.io");
    privacyVaultFor("s3").mask("nothing");
    expect(privacyShieldTotals()).toEqual({ masked: 3, sessions: 2 });
    forgetPrivacyVault("s1");
    expect(privacyShieldTotals()).toEqual({ masked: 1, sessions: 1 });
  });

  it("passes the agent's known keys to new vaults", () => {
    setPrivacyKnownSecrets(() => [{ label: "MY_KEY", value: "Zq8vLp3mWx7tRb2n" }]);
    expect(privacyVaultFor("s1").mask("key Zq8vLp3mWx7tRb2n")).toBe("key [SECRET_1]");
  });

  it("links a Fusion worker to its parent's vault and forgets the links with the parent (ATO-1083)", () => {
    linkPrivacyVault("s-w-1", "s1");
    linkPrivacyVault("s-w-2", "s-w-1");
    expect(privacyVaultFor("s-w-1")).toBe(privacyVaultFor("s1"));
    expect(privacyVaultFor("s-w-2")).toBe(privacyVaultFor("s1"));
    privacyVaultFor("s-w-1").mask("a@b.io");
    expect(privacyShieldTotals()).toEqual({ masked: 1, sessions: 1 });
    forgetPrivacyVault("s1");
    expect(privacyVaultFor("s-w-1")).not.toBe(privacyVaultFor("s1"));
  });

  it("is off until switched on", () => {
    expect(isPrivacyShieldEnabled()).toBe(false);
    setPrivacyShieldEnabled(true);
    expect(isPrivacyShieldEnabled()).toBe(true);
  });
});

it("bounds the registry and retains recently used sessions", () => {
  const oldest = privacyVaultFor("oldest");
  const recent = privacyVaultFor("recent");
  for (let index = 0; index < 128; index += 1) {
    privacyVaultFor(`session-${index}`);
    expect(privacyVaultFor("recent")).toBe(recent);
  }
  expect(privacyVaultFor("oldest")).not.toBe(oldest);
});

it("keeps an active turn's vault through registry pressure", () => {
  const release = pinPrivacyVault("active");
  try {
    const original = privacyVaultFor("active");
    for (let i = 0; i < 140; i++) privacyVaultFor(`idle-${i}`);
    expect(privacyVaultFor("active")).toBe(original);
  } finally {
    release();
  }
});

it("keeps the turn setting across awaits and worker fan-out after a toggle", async () => {
  setPrivacyShieldEnabled(true);
  await withPrivacyShieldTurn("chat", async () => {
    await Promise.resolve();
    setPrivacyShieldEnabled(false);
    expect(isPrivacyShieldEnabledForRequest("chat")).toBe(true);
    expect(isPrivacyShieldEnabledForRequest("unrelated")).toBe(false);
    withPrivacyShieldTurn("chat", () => {
      expect(isPrivacyShieldEnabledForRequest("chat")).toBe(false);
    });
    linkPrivacyVault("worker", "chat");
    withPrivacyShieldTurn("worker", () => {
      expect(isPrivacyShieldEnabledForRequest("worker")).toBe(true);
    });
  });
  withPrivacyShieldTurn("chat", () => {
    expect(isPrivacyShieldEnabledForRequest("chat")).toBe(false);
  });
});

it("pins the shared archive during a worker turn and releases the worker link on exit", () => {
  linkPrivacyVault("worker", "planner");
  const release = pinPrivacyVault("worker");
  const planner = privacyVaultFor("planner");
  expect(planner.mask("first@example.test second@example.test")).toBe("[EMAIL_1] [EMAIL_2]");
  for (let i = 0; i < 140; i++) privacyVaultFor("idle-" + i);
  expect(privacyVaultFor("worker").mask("second@example.test")).toBe("[EMAIL_2]");
  forgetPrivacyVault("worker");
  expect(privacyVaultFor("worker")).not.toBe(planner);
  expect(privacyVaultFor("planner")).toBe(planner);
  release();
  forgetPrivacyVault("planner");
  expect(privacyVaultFor("planner").isEmpty).toBe(true);
});

it("redacts evidence independently of provider counters and placeholder numbering", () => {
  const vault = privacyVaultFor("fusion");
  vault.mask("password=Qf8zT2Mk5Kn");
  const evidence = { path: "build/Qf8zT2Mk5Kn.html", label: "owner@example.test", count: 1 };
  expect(redactPrivacyEvidence("fusion", evidence)).toEqual({ path: "[redacted]", label: "[redacted]", count: 1 });
  expect(vault.stats().distinct).toBe(1);
  expect(vault.mask("owner@example.test")).toBe("[EMAIL_1]");
});
