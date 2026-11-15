import { describe, expect, it } from "vitest";

import type { UserLlmRunModeConfig } from "../../config/llm-run-mode-config.js";
import type { ResolvedLlmConfig } from "../provider/registry/provider-types.js";
import { parseTeamMember, type TeamMember } from "./fusion-team.js";
import { resolveRunMode } from "./resolve-run-mode.js";

const providers: ResolvedLlmConfig["providers"] = [
  { id: "api", kind: "anthropic", defaultChatModel: "model-a" },
  { id: "cli", kind: "subscription-cli", defaultChatModel: "" },
  { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
];

function llm(active: string, runMode: UserLlmRunModeConfig): ResolvedLlmConfig {
  return { activeTextProvider: active, activeEmbeddingProvider: "local-llama", providers, toolTransport: "auto", runMode };
}

const member = (ref: string): TeamMember => parseTeamMember(ref)!;

const fusion: UserLlmRunModeConfig = {
  mode: "fusion",
  fusion: {
    orchestratorProvider: "api",
    workerProvider: "cli",
    workerModel: "model-w",
    team: { directors: ["api:model-a", "cli:model-d"], workers: ["cli:model-w"] },
  },
};

describe("resolveRunMode with a session director", () => {
  it("makes fusion effective for the director without the active provider being it", () => {
    const rm = resolveRunMode(llm("local-llama", fusion), { director: member("cli:model-d") });
    expect(rm.effective).toBe("fusion");
    expect(rm.orchestratorProviderId).toBe("cli");
    expect(rm.orchestratorModel).toBe("model-d");
    expect(rm.primaryProviderId).toBe("cli");
    expect(rm.director).toEqual(member("cli:model-d"));
  });

  it("keeps the worker leg on the same provider as the director when the models differ", () => {
    const rm = resolveRunMode(llm("api", fusion), { director: member("cli:model-d") });
    expect(rm.workerProviderId).toBe("cli");
    expect(rm.workerModel).toBe("model-w");
    // Escalation from the worker to the director is a different member.
    expect(rm.escalation?.providerId).toBe("cli");
    expect(rm.escalation?.model).toBe("model-d");
  });

  it("takes the session's preferred worker as the worker leg", () => {
    const rm = resolveRunMode(llm("api", fusion), {
      director: member("api:model-a"),
      worker: member("cli:model-x"),
    });
    expect(rm.workerProviderId).toBe("cli");
    expect(rm.workerModel).toBe("model-x");
  });

  it("ignores a preferred worker that is the director itself", () => {
    const rm = resolveRunMode(llm("api", fusion), {
      director: member("cli:model-w"),
      worker: member("cli:model-w"),
    });
    expect(rm.workerModel).toBe("model-w");
    expect(rm.escalation).toBeNull();
  });

  it("does not turn fusion on when the stored mode is not fusion", () => {
    const rm = resolveRunMode(llm("api", { ...fusion, mode: "cloud" }), { director: member("cli:model-d") });
    expect(rm.effective).toBe("cloud");
    expect(rm.director).toBeUndefined();
  });

  it("ignores a director whose provider is not configured", () => {
    const rm = resolveRunMode(llm("local-llama", fusion), { director: member("gone:model-z") });
    expect(rm.effective).toBe("local");
    expect(rm.director).toBeUndefined();
  });

  it("without a director keeps today's rule", () => {
    expect(resolveRunMode(llm("local-llama", fusion)).effective).toBe("local");
    expect(resolveRunMode(llm("api", fusion)).effective).toBe("fusion");
    expect(resolveRunMode(llm("api", fusion)).director).toBeUndefined();
  });
});
