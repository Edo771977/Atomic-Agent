import { afterEach, describe, expect, it } from "vitest";
import { getConfig, resetConfigCache } from "../../config/index.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import { openAiToolCallAdapter } from "../../llm/provider/openai/openai-tool-call-adapter.js";
import { SlotManager } from "../../llm/slot-manager.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { ToolDescriptor } from "../../prompt/stable-prefix.js";
import type { StepContext, StepDependencies } from "./step-contract.js";
import type { BuildPromptInput, BuiltPrompt } from "../../prompt/build-prompt-types.js";
import { buildPrompt } from "../../prompt/build-prompt.js";
import type { StepEvent } from "../step-events.js";
import { grammarFallbackPromptInput, nativeToolSchemaTokens, prepareStepInference, prepareStepPrompt } from "./step-inference.js";

/**
 * ATO-1678: the `tools` array a native-tools link sends beside the text
 * is budgeted on a local link too, not only on a cloud one. Without it
 * a local Ollama / LM Studio / Fusion worker prompt was packed as if the
 * schemas took no room, and the reply ran into the end of the window.
 */

afterEach(() => resetConfigCache());

const DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "os.fs.write",
    summary: "Write a file.",
    argsSchema: "{ path: string, content: string, mode?: \"overwrite\" | \"append\" }",
  },
  { name: "reply", summary: "Answer the user.", argsSchema: "{ text: string }" },
];

function fixture(transport: "native_tools" | "grammar"): { ctx: StepContext; deps: StepDependencies } {
  return {
    ctx: {
      session: {
        ...createEmptySessionState({ id: "schema-budget", workingDir: "/fixture" }),
        turns: [{ kind: "user", text: "write it", at: 1 }],
      },
      toolDescriptors: DESCRIPTORS,
      skillCatalog: [],
      capabilities: {
        platform: "win32", arch: "x64", browserChannel: "chrome",
        workingDir: "/fixture", hasClipboard: false, hasWmctrl: false,
        hasNotifications: false,
      },
      stepIndex: 1,
      signal: new AbortController().signal,
    },
    deps: {
      registry: new ToolRegistry(),
      slotManager: new SlotManager(1),
      profile: PLAIN_INSTRUCT_PROFILE,
      grammar: 'root ::= "fixture"',
      toolTransport: transport,
      toolCallAdapter: null,
      supportsSlotAffinity: false,
      // No model mode: a local link, as every local provider resolves.
      contextWindow: 32_768,
      profileWindowApplies: false,
      llmComplete: async () => { throw new Error("not called"); },
    },
  };
}

describe("native tool schemas in the local step budget (ATO-1678)", () => {
  it("passes the tools array's size to a local native-tools prompt", () => {
    const { ctx, deps } = fixture("native_tools");
    const { prompt } = prepareStepInference(ctx, deps);
    const expected = nativeToolSchemaTokens(DESCRIPTORS, deps);
    expect(expected).toBeGreaterThan(0);
    expect(prompt.tokens.toolSchema).toBe(expected);
  });

  it("keeps the conversation cut and stable prefix across a restricted terminal step", () => {
    const { ctx, deps } = fixture("native_tools");
    ctx.session = { ...ctx.session, turns: Array.from({ length: 100 }, (_, i) => [
      { kind: "user" as const, at: i * 2, text: `Message ${i}: ${"history ".repeat(180)}` },
      { kind: "assistant_reply" as const, at: i * 2 + 1, text: `Answer ${i}` },
    ]).flat() };
    const first = prepareStepInference(ctx, deps);
    const terminal = prepareStepInference({
      ...ctx,
      stepIndex: ctx.stepIndex + 1,
      terminalOnly: true,
      toolSet: { names: ["reply"], reason: "Final report" },
    }, deps);
    expect(terminal.llmParams.tools!.length).toBeLessThan(first.llmParams.tools!.length);
    expect(terminal.prompt.tokens.toolSchema).toBe(first.prompt.tokens.toolSchema);
    expect(terminal.prompt.conversationCapEffective).toBe(first.prompt.conversationCapEffective);
    expect(first.prompt.conversationPackStart).not.toBeNull();
    expect(terminal.prompt.conversationPackStart).toEqual(first.prompt.conversationPackStart);
    expect(Buffer.from(terminal.prompt.stablePrefix)).toEqual(Buffer.from(first.prompt.stablePrefix));
  });

  it("preserves prompt bytes when a native link has no tools to send", () => {
    const { ctx, deps } = fixture("native_tools");
    ctx.toolSet = { names: [], reason: "No tools are available" };
    const withoutNativeTools = {
      ...deps,
      toolCallAdapter: { ...openAiToolCallAdapter, descriptorsToTools: () => [] },
    };
    // The ordinary adapter still sends the implicit reply and finish tools.
    expect(prepareStepInference(ctx, deps).prompt.tokens.toolSchema).toBeGreaterThan(0);
    const { promptInput } = prepareStepPrompt(ctx, withoutNativeTools);
    const { prompt: actual, llmParams } = prepareStepInference(ctx, withoutNativeTools);
    const { toolSchemaTokens: _omitted, ...referenceInput } = promptInput;
    const reference = buildPrompt(referenceInput);
    expect(llmParams.tools).toEqual([]);
    expect(actual.tokens.toolSchema).toBeUndefined();
    expect(actual.conversationCapEffective).toBe(reference.conversationCapEffective);
    expect(Buffer.from(actual.text)).toEqual(Buffer.from(reference.text));
  });

  it("leaves a grammar link's budget without it", () => {
    const { ctx, deps } = fixture("grammar");
    const { prompt } = prepareStepInference(ctx, deps);
    expect(prompt.tokens.toolSchema).toBeUndefined();
  });

  it("budgets a native-tools fallback link with its own tools array", () => {
    const { ctx, deps } = fixture("grammar");
    const built: BuiltPrompt[] = [];
    const linkWindow = 32_768;
    const primaryDeps: StepDependencies = {
      ...deps,
      modelModePolicy: { activeProviderId: "primary", providers: [] },
      modelMode: { mode: "local", source: "provider", providerId: "primary", modelId: null },
      onEvent: (event: StepEvent) => {
        if (event.type === "prompt_built") built.push(event.prompt);
      },
    };
    const prepared = prepareStepInference(ctx, primaryDeps);
    const linkMode = { mode: "local" as const, source: "provider" as const, providerId: "fallback", modelId: null };
    prepared.llmParams.prepareForLink!({ modelMode: linkMode, transport: "native_tools", contextWindow: linkWindow });
    const linked = built.at(-1)!;
    const schemas = nativeToolSchemaTokens(DESCRIPTORS, deps);
    expect(schemas).toBeGreaterThan(0);
    expect(linked.tokens.toolSchema).toBe(schemas);
    // The same link prompt, rebuilt the way `prepareForLink` does but
    // without the schemas: its cap is larger by exactly their size
    // (auto cap, well above the floor).
    const linkInput: BuildPromptInput = { ...prepareStepPrompt(ctx, primaryDeps).promptInput };
    delete linkInput.compactPrompt;
    delete linkInput.compactPromptWindow;
    const reference = buildPrompt({
      ...linkInput, session: ctx.session, modelMode: linkMode,
      toolTransport: "native_tools", contextWindow: linkWindow, profileWindowApplies: false,
      toolSchemaTokens: 0, suppressReasoningPrefill: true,
      completionMaxTokens: getConfig().localModels.completionMaxTokens,
    });
    expect(reference.conversationCapEffective - linked.conversationCapEffective).toBe(schemas);
  });

  it("rebuilds the grammar fallback prompt without the primary's tools array", () => {
    const { ctx, deps } = fixture("native_tools");
    const { promptInput } = prepareStepPrompt(ctx, deps);
    expect(promptInput.toolSchemaTokens).toBeGreaterThan(0);
    const fallback = buildPrompt(grammarFallbackPromptInput(promptInput));
    const { toolSchemaTokens: _dropped, ...withoutSchemas } = promptInput;
    const reference = buildPrompt({ ...withoutSchemas, toolTransport: "grammar", suppressReasoningPrefill: false });
    expect(fallback.tokens.toolSchema).toBeUndefined();
    expect(fallback.conversationCapEffective).toBe(reference.conversationCapEffective);
  });
});
