import { afterEach, expect, it, vi } from "vitest";
import { loadJudgeConfigFromEnv } from "./judge-client.js";

afterEach(() => vi.unstubAllEnvs());

it("reserves the OpenRouter key for its own judge endpoint or literal loopback", () => {
  vi.stubEnv("ATOMIC_AGENT_JUDGE_DISABLED", undefined);
  vi.stubEnv("OPENROUTER_API_KEY", "fixture-openrouter");
  vi.stubEnv("ATOMIC_AGENT_JUDGE_API_KEY", "fixture-gateway");
  vi.stubEnv("ATOMIC_AGENT_JUDGE_URL", "https://judge.example.test/api/v1");
  expect(loadJudgeConfigFromEnv()?.apiKey).toBe("fixture-gateway");
  vi.stubEnv("ATOMIC_AGENT_JUDGE_URL", "https://openrouter.ai/api/v1");
  expect(loadJudgeConfigFromEnv()?.apiKey).toBe("fixture-openrouter");
  vi.stubEnv("ATOMIC_AGENT_JUDGE_URL", "http://127.0.0.1:9090");
  expect(loadJudgeConfigFromEnv()?.apiKey).toBe("fixture-openrouter");
});
