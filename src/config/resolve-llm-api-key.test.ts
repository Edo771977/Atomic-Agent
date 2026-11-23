import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { mayReceiveOpenAiKey, resolveLlmProviderApiKey, resolveLlmProviderApiKeyWithSource } from "./resolve-llm-api-key.js";

describe("resolveLlmProviderApiKey", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("resolves Gemini keys from GEMINI_API_KEY", () => {
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");

    expect(resolveLlmProviderApiKey({ id: "gemini", kind: "gemini" })).toBe(
      "gemini-test-key",
    );
  });

  it("resolves native Anthropic keys from ANTHROPIC_API_KEY", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    expect(resolveLlmProviderApiKey({ id: "claude", kind: "anthropic" })).toBe("sk-ant-test");
  });
});

describe("resolveLlmProviderApiKey for a server on another computer (ATO-1066)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("never sends the shared OpenAI key to a LAN address", () => {
    // Unset, not empty: an empty OPENAI_COMPAT_API_KEY would win the `??`
    // chain and hide the leak this test is about.
    const saved = {
      OPENAI_COMPAT_API_KEY: process.env.OPENAI_COMPAT_API_KEY,
      ATOMIC_AGENT_OPENAI_API_KEY: process.env.ATOMIC_AGENT_OPENAI_API_KEY,
    };
    delete process.env.OPENAI_COMPAT_API_KEY;
    delete process.env.ATOMIC_AGENT_OPENAI_API_KEY;
    onTestFinished(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value !== undefined) process.env[name] = value;
      }
    });
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    expect(
      resolveLlmProviderApiKey({
        id: "custom-192-168-1-20-8080",
        kind: "openai-compatible",
        baseUrl: "http://192.168.1.20:8080",
      }),
    ).toBeUndefined();
  });

  it("still uses the LAN entry's own key or key variable", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("ATOMIC_AGENT_KEY_LAN", "lan-key");
    expect(
      resolveLlmProviderApiKey({
        id: "lan",
        kind: "openai-compatible",
        baseUrl: "http://192.168.1.20:8080",
        apiKey: "stored",
      }),
    ).toBe("stored");
    expect(
      resolveLlmProviderApiKey({
        id: "lan",
        kind: "openai-compatible",
        baseUrl: "http://192.168.1.20:8080",
        apiKeyEnvVar: "ATOMIC_AGENT_KEY_LAN",
      }),
    ).toBe("lan-key");
  });

  it("keeps the shared fallback for a cloud endpoint", () => {
    vi.stubEnv("OPENAI_COMPAT_API_KEY", "sk-test");
    expect(
      resolveLlmProviderApiKey({
        id: "openai-compatible",
        kind: "openai-compatible",
        baseUrl: "https://api.openai.com",
      }),
    ).toBe("sk-test");
  });
});

describe("resolveLlmProviderApiKey: the shared OpenAI key goes only over https or to this machine", () => {
  afterEach(() => vi.unstubAllEnvs());

  function withSharedKey(): void {
    for (const name of ["OPENAI_COMPAT_API_KEY", "ATOMIC_AGENT_OPENAI_API_KEY"]) {
      const saved = process.env[name];
      delete process.env[name];
      onTestFinished(() => {
        if (saved !== undefined) process.env[name] = saved;
      });
    }
    vi.stubEnv("OPENAI_API_KEY", "sk-shared");
  }

  const compat = (baseUrl?: string) => ({
    id: "custom",
    kind: "openai-compatible" as const,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });

  it("keeps the fallback for an https endpoint, even on a public IP", () => {
    withSharedKey();
    expect(resolveLlmProviderApiKey(compat("https://8.8.8.8"))).toBe("sk-shared");
    expect(resolveLlmProviderApiKey(compat("https://api.together.xyz"))).toBe("sk-shared");
  });

  it("keeps the fallback when no baseUrl is set (the default endpoint is https)", () => {
    withSharedKey();
    expect(resolveLlmProviderApiKey(compat())).toBe("sk-shared");
  });

  it("sends no shared key over plain http to a public host", () => {
    withSharedKey();
    for (const url of ["http://8.8.8.8", "http://api.example.com:8080", "http://[2001:db8::1]"]) {
      expect(resolveLlmProviderApiKey(compat(url)), url).toBeUndefined();
    }
    expect(resolveLlmProviderApiKey({ ...compat("http://8.8.8.8"), kind: "qwen-openai-compatible" })).toBeUndefined();
  });

  it("sends no shared key over https to a name of the operator's own network", () => {
    withSharedKey();
    for (const url of [
      "https://gpu.tail1234.ts.net",
      "https://nas.home",
      "https://gpu.localdomain",
      "https://gpu.corp",
      "https://wiki.intranet",
      "https://192.168.1.5.nip.io",
      "https://whatever.sslip.io",
    ]) {
      expect(resolveLlmProviderApiKey(compat(url)), url).toBeUndefined();
    }
    expect(resolveLlmProviderApiKey(compat("https://8.8.8.8.nip.io"))).toBe("sk-shared");
  });

  it("keeps the fallback over plain http to this machine", () => {
    withSharedKey();
    for (const url of ["http://localhost:8080", "http://127.0.0.2:8080", "http://[::1]:8080", "http://0.0.0.0:8080", "http://[::]:8080", "http://localhost.:8080"]) {
      expect(resolveLlmProviderApiKey(compat(url)), url).toBe("sk-shared");
    }
  });

  it("still honours an explicit apiKeyEnvVar naming a shared variable, and a stored key", () => {
    withSharedKey();
    expect(resolveLlmProviderApiKey({ ...compat("http://8.8.8.8"), apiKeyEnvVar: "OPENAI_API_KEY" })).toBe("sk-shared");
    expect(resolveLlmProviderApiKey({ ...compat("http://8.8.8.8"), apiKey: "own" })).toBe("own");
  });
});

describe("placeholder keys are not sent (owner's Windows run)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("treats ANTHROPIC_API_KEY=... as missing, not as a key to send", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "...");
    expect(resolveLlmProviderApiKey({ id: "anthropic", kind: "anthropic" })).toBeUndefined();
    expect(resolveLlmProviderApiKeyWithSource({ id: "anthropic", kind: "anthropic" })).toEqual({
      ignored: { source: { kind: "env", name: "ANTHROPIC_API_KEY" }, length: 3, reason: expect.stringMatching(/placeholder/) },
    });
  });

  it("a placeholder config apiKey falls through to the environment", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-real-looking-key-0123456789");
    expect(resolveLlmProviderApiKeyWithSource({ id: "anthropic", kind: "anthropic", apiKey: "<key>" }).key).toEqual({
      value: "sk-ant-api03-real-looking-key-0123456789",
      source: { kind: "env", name: "ANTHROPIC_API_KEY" },
    });
  });

  it("names the source of the key it used", () => {
    vi.stubEnv("GROQ_API_KEY", "gsk-real-looking-key-0123456789");
    expect(resolveLlmProviderApiKeyWithSource({ id: "groq", kind: "openai-compatible", apiKeyEnvVar: "GROQ_API_KEY", baseUrl: "https://api.groq.com/openai" }).key?.source)
      .toEqual({ kind: "env", name: "GROQ_API_KEY" });
    expect(resolveLlmProviderApiKeyWithSource({ id: "x", kind: "openrouter", apiKey: "stored-key" }).key?.source).toEqual({ kind: "config" });
  });
});

describe("resolveLlmProviderApiKey for a server on another computer (ATO-1066)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("never sends the shared OpenAI key to a LAN address", () => {
    // Unset, not empty: an empty OPENAI_COMPAT_API_KEY would win the `??`
    // chain and hide the leak this test is about.
    const saved = {
      OPENAI_COMPAT_API_KEY: process.env.OPENAI_COMPAT_API_KEY,
      ATOMIC_AGENT_OPENAI_API_KEY: process.env.ATOMIC_AGENT_OPENAI_API_KEY,
    };
    delete process.env.OPENAI_COMPAT_API_KEY;
    delete process.env.ATOMIC_AGENT_OPENAI_API_KEY;
    onTestFinished(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value !== undefined) process.env[name] = value;
      }
    });
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    expect(
      resolveLlmProviderApiKey({
        id: "custom-192-168-1-20-8080",
        kind: "openai-compatible",
        baseUrl: "http://192.168.1.20:8080",
      }),
    ).toBeUndefined();
  });

  it("still uses the LAN entry's own key or key variable", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("ATOMIC_AGENT_KEY_LAN", "lan-key");
    expect(
      resolveLlmProviderApiKey({
        id: "lan",
        kind: "openai-compatible",
        baseUrl: "http://192.168.1.20:8080",
        apiKey: "stored",
      }),
    ).toBe("stored");
    expect(
      resolveLlmProviderApiKey({
        id: "lan",
        kind: "openai-compatible",
        baseUrl: "http://192.168.1.20:8080",
        apiKeyEnvVar: "ATOMIC_AGENT_KEY_LAN",
      }),
    ).toBe("lan-key");
  });

  it("keeps the shared fallback for a cloud endpoint", () => {
    vi.stubEnv("OPENAI_COMPAT_API_KEY", "sk-test");
    expect(
      resolveLlmProviderApiKey({
        id: "openai-compatible",
        kind: "openai-compatible",
        baseUrl: "https://api.openai.com",
      }),
    ).toBe("sk-test");
  });
});

describe("resolveLlmProviderApiKey: the OpenAI key only goes to OpenAI (ATO-1703)", () => {
  const SHARED = [
    "OPENAI_COMPAT_API_KEY",
    "OPENAI_API_KEY",
    "ATOMIC_AGENT_OPENAI_API_KEY",
  ] as const;

  // Unset, not stubbed to "": an empty variable still wins the `??` chain
  // and would hide what each case is about.
  function withEnv(vars: Partial<Record<(typeof SHARED)[number], string>>): void {
    const saved = Object.fromEntries(SHARED.map((n) => [n, process.env[n]]));
    for (const name of SHARED) delete process.env[name];
    for (const [name, value] of Object.entries(vars)) process.env[name] = value;
    onTestFinished(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
  }

  afterEach(() => vi.unstubAllEnvs());

  const compat = (baseUrl?: string) => ({
    id: "custom",
    kind: "openai-compatible" as const,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });

  it("does not send OPENAI_API_KEY to a server a config file named", () => {
    withEnv({ OPENAI_API_KEY: "sk-real" });
    expect(resolveLlmProviderApiKey(compat("https://llm.example.com"))).toBeUndefined();
    expect(resolveLlmProviderApiKey(compat("https://api.openai.com.evil.example/v1"))).toBeUndefined();
    expect(resolveLlmProviderApiKey(compat("http://api.openai.com"))).toBeUndefined();
    expect(resolveLlmProviderApiKey(compat("not a url"))).toBeUndefined();
  });

  it("does not send ATOMIC_AGENT_OPENAI_API_KEY there either", () => {
    withEnv({ ATOMIC_AGENT_OPENAI_API_KEY: "sk-real" });
    expect(resolveLlmProviderApiKey(compat("https://llm.example.com"))).toBeUndefined();
  });

  it("applies the same rule to the Qwen compat kind", () => {
    withEnv({ OPENAI_API_KEY: "sk-real" });
    expect(
      resolveLlmProviderApiKey({
        id: "qwen",
        kind: "qwen-openai-compatible",
        baseUrl: "https://dashscope.example.com/compatible-mode",
      }),
    ).toBeUndefined();
  });

  it("still sends OPENAI_API_KEY to OpenAI, this machine, or the default endpoint", () => {
    withEnv({ OPENAI_API_KEY: "sk-real" });
    expect(resolveLlmProviderApiKey(compat("https://api.openai.com"))).toBe("sk-real");
    expect(resolveLlmProviderApiKey(compat("https://API.openai.com/v1/"))).toBe("sk-real");
    expect(resolveLlmProviderApiKey(compat("http://127.0.0.1:8080"))).toBe("sk-real");
    expect(resolveLlmProviderApiKey(compat("http://localhost:1234/v1"))).toBe("sk-real");
    expect(resolveLlmProviderApiKey(compat())).toBe("sk-real");
  });

  it("keeps OPENAI_COMPAT_API_KEY working for any compat server", () => {
    withEnv({ OPENAI_COMPAT_API_KEY: "compat-key", OPENAI_API_KEY: "sk-real" });
    expect(resolveLlmProviderApiKey(compat("https://llm.example.com"))).toBe("compat-key");
  });

  it("keeps the entry's own key and key variable first", () => {
    withEnv({ OPENAI_API_KEY: "sk-real" });
    vi.stubEnv("ATOMIC_AGENT_KEY_CUSTOM", "own-var");
    expect(
      resolveLlmProviderApiKey({ ...compat("https://llm.example.com"), apiKey: "stored" }),
    ).toBe("stored");
    expect(
      resolveLlmProviderApiKey({
        ...compat("https://llm.example.com"),
        apiKeyEnvVar: "ATOMIC_AGENT_KEY_CUSTOM",
      }),
    ).toBe("own-var");
  });
});

describe("mayReceiveOpenAiKey (ATO-1703)", () => {
  it("answers true only for OpenAI's API, this machine, or no address", () => {
    expect(mayReceiveOpenAiKey(undefined)).toBe(true);
    expect(mayReceiveOpenAiKey("")).toBe(true);
    expect(mayReceiveOpenAiKey("https://api.openai.com/v1")).toBe(true);
    expect(mayReceiveOpenAiKey("http://[::1]:8080")).toBe(true);
    expect(mayReceiveOpenAiKey("https://api.openai.com:8443")).toBe(false);
    expect(mayReceiveOpenAiKey("https://openai.com")).toBe(false);
    expect(mayReceiveOpenAiKey("http://192.168.1.20:8080")).toBe(false);
  });
});
