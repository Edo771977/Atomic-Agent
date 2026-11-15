import { describe, expect, it } from "vitest";

import { makeProviderPolicy } from "../config/project-constraint-match.js";
import { ProviderNotAllowedError } from "../llm/provider-policy.js";
import { EgressNotAllowedError } from "../tools/tool-egress.js";
import { findConstraintRefusal, formatConstraintRefusal } from "./constraint-refusal.js";

const policy = makeProviderPolicy({ key: "/work/client", allowedProviders: ["local-llama"], matchedDir: "/work/client" });

describe("findConstraintRefusal", () => {
  it("reads a provider refusal through the fallback chain's causes", () => {
    const refusal = new ProviderNotAllowedError({ reason: "not-allowed", providerId: "anthropic", policy, role: "the main model" });
    const wrapped = new Error("all links failed", { cause: refusal });
    const found = findConstraintRefusal(wrapped);
    expect(found).toMatchObject({
      code: "ATOMIC_AGENT_PROVIDER_NOT_ALLOWED",
      folder: "/work/client",
      message: "This folder is restricted to: local-llama. The main model can't use anthropic here.",
    });
    expect(formatConstraintRefusal(found!, { localModelConfigured: true })).toBe(
      "This folder is restricted to: local-llama. The main model can't use anthropic here.\n  switch to local with ctrl+r or /runmode local",
    );
    expect(formatConstraintRefusal(found!, { localModelConfigured: false })).toContain(
      'edit projects.constraints["/work/client"].allowedProviders in config.json',
    );
  });

  it("names read taint and the none-allowed case", () => {
    const tainted = makeProviderPolicy({ key: "/work/client", allowedProviders: ["local-llama"], matchedDir: "/home/me", readFrom: ["/work/client"] });
    const none = new ProviderNotAllowedError({ reason: "none-allowed", policy: tainted, role: "the main model" });
    expect(findConstraintRefusal(none)?.message).toBe(
      "This session read files from /work/client, which is restricted to: local-llama. No allowed provider can serve the main model.",
    );
  });

  it("reads an egress refusal that ends a turn", () => {
    const err = new EgressNotAllowedError("os.web.fetch", "web", policy);
    const found = findConstraintRefusal(err);
    expect(found).toMatchObject({ code: "ATOMIC_AGENT_EGRESS_NOT_ALLOWED", folder: "/work/client" });
    expect(found?.message).toBe("This folder (/work/client) is restricted: os.web.fetch can't send content off this machine here.");
    expect(formatConstraintRefusal(found!, { localModelConfigured: true })).toContain('add "web" to projects.constraints["/work/client"].allowedEgress');
  });

  it("is null for any other failure", () => {
    expect(findConstraintRefusal(new Error("fetch failed"))).toBeNull();
    expect(findConstraintRefusal("x")).toBeNull();
  });
});
