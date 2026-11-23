import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { createEmptySessionState, type SessionState } from "../../session/session-state.js";
import { learnedSkillScope } from "../../skills/learning/learn-scope.js";
import { hashSkillText, listPendingDrafts, savePendingDraft } from "../../skills/learning/pending-drafts.js";
import { SkillsOrchestrator } from "./skills-orchestrator.js";
import type { TuiEventBus } from "../tui-app.js";

describe("/learn draft approval", () => {
  it("shows the full text and refuses activation in incognito or while a turn is running", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "tui-learn-"));
    try {
      const session = createEmptySessionState({ id: "learn", workingDir: stateDir });
      let current: SessionState = { ...session, incognito: { since: 1, owner: "test" } };
      const emit = vi.fn();
      const isBusy = vi.fn(() => true);
      const runtime = {
        config: { paths: { stateDir } }, turnController: { isBusy },
        sessionStore: { liveFolderTurn: () => false },
        skillRegistry: { listAll: () => [] }, refreshSkills: vi.fn(async () => {}),
      } as unknown as AgentRuntime;
      const orchestrator = new SkillsOrchestrator(runtime, { emit } as unknown as TuiEventBus, {
        currentSession: () => current,
      });
      const scope = learnedSkillScope(stateDir, stateDir);
      const content = "---\nname: review-report\ndescription: Review a release report.\n---\nOpen the report and compare each heading with the expected checklist.\n";
      const { id } = await savePendingDraft(scope.stateDir, {
        kind: "create", name: "review-report", reason: "release checklist", sources: [], content,
      });
      const fingerprint = hashSkillText(content);
      const approval = { kind: "approve", id, fingerprint } as const;
      await orchestrator.runLearnCommand(approval);
      expect(emit).toHaveBeenLastCalledWith({ type: "system_message", text: expect.stringContaining("regular chat") });
      current = session;
      await orchestrator.runLearnCommand({ kind: "show", id, json: false });
      expect(emit).toHaveBeenLastCalledWith({ type: "system_message", text: expect.stringContaining(content.trimEnd()) });
      expect(emit).toHaveBeenLastCalledWith({ type: "system_message", text: expect.stringContaining(fingerprint) });
      await orchestrator.runLearnCommand(approval);
      expect(emit).toHaveBeenLastCalledWith({ type: "system_message", text: expect.stringContaining("A turn is running") });
      expect(await listPendingDrafts(scope.stateDir)).toHaveLength(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
