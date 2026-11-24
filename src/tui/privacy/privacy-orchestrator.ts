import type { AnalyticsDisabledVia } from "../../analytics/index.js";
import { getConfig } from "../../config/index.js";
import { parseTeamMember, teamMembers, type TeamRole } from "../../llm/run-mode/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { TuiEventBus } from "../tui-app.js";
import { AGENT_TOOL_CHILD_ENV } from "../../sandbox/command-env.js";
import { persistAnalyticsEnabled } from "../persist-analytics-enabled.js";
import {
  readOfflineModeControl,
  snapshotOfflineMode,
} from "./offline-mode.js";
import { readPrivacyShieldControl, snapshotPrivacyShield } from "./privacy-shield.js";

/**
 * Only TUI module that persists `analytics.enabled` and hot-applies it
 * to the runtime. The reducer/component stay pure; every side effect
 * (config write, `resetConfigCache`, `runtime.setAnalyticsEnabled`) is
 * funnelled through here — mirrors the other TUI orchestrators.
 */
export class PrivacyOrchestrator {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
    private readonly currentSessionId: () => string | undefined = () => undefined,
  ) {}

  /**
   * Push the current settings snapshot into the UI: the persisted
   * `analytics.enabled` plus the live session grants. Also mirrors the
   * LIVE approval-gate level into `state.session` so the diagnostics
   * line stays truthful (e.g. after a `--no-approval` boot).
   */
  refresh(): void {
    const config = getConfig();
    const team = config.llm?.runMode?.fusion?.team;
    const roles: readonly TeamRole[] = ["directors", "workers", "reviewers"];
    const shield = snapshotPrivacyShield(readPrivacyShieldControl(this.runtime), this.currentSessionId());
    const members = roles.flatMap((role) => teamMembers(team, role));
    const planReviewer = team?.planReviewer === undefined ? null : parseTeamMember(team.planReviewer);
    if (planReviewer) members.push(planReviewer);
    if (members.some(({ providerId }) =>
      config.llm?.providers.some((provider) => provider.id === providerId && provider.kind === "subscription-cli"),
    )) shield.fusionUsesSubscriptionCli = true;
    this.bus.emit({
      type: "privacy_synced",
      analyticsEnabled: config.analytics.enabled,
      sessionGrants: this.runtime.approvals.sessionGrants(),
      offline: snapshotOfflineMode(readOfflineModeControl(this.runtime)),
      shield,
    });
    this.bus.emit({
      type: "approval_level_changed",
      approvalLevel: this.runtime.getApprovalLevel(),
    });
  }

  /**
   * Flip offline mode (ATO-1087) through the agent's own kill switch
   * (ATO-1084), which persists and applies it. A runtime without the switch
   * gets a plain line and no state change: the tab never fakes the mode.
   */
  async toggleOffline(): Promise<void> {
    const control = readOfflineModeControl(this.runtime);
    if (!control) {
      this.bus.emit({
        type: "privacy_action_settled",
        error: "offline mode is not available in this agent build",
      });
      return;
    }
    this.bus.emit({ type: "privacy_action_started" });
    try {
      const next = !control.isEnabled();
      await control.setEnabled(next);
      this.bus.emit({
        type: "privacy_action_settled",
        message: next ? "offline mode on" : "offline mode off",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit({
        type: "privacy_action_settled",
        error: `offline mode toggle failed: ${msg}`,
      });
    }
    // Re-read either way: the panel shows what the agent says now.
    this.refresh();
  }

  /**
   * Flip Privacy Shield (ATO-1082) through the agent's own control, which
   * persists `privacy.shield.enabled` and applies it to the next
   * turn. A runtime without it gets a plain line and no state change.
   */
  async toggleShield(): Promise<void> {
    if (process.env[AGENT_TOOL_CHILD_ENV] !== undefined) {
      this.bus.emit({
        type: "privacy_action_settled",
        error: "privacy shield can only be changed by the operator",
      });
      return;
    }
    const control = readPrivacyShieldControl(this.runtime);
    if (!control) {
      this.bus.emit({
        type: "privacy_action_settled",
        error: "privacy shield is not available in this agent build",
      });
      return;
    }
    this.bus.emit({ type: "privacy_action_started" });
    try {
      const next = !control.isEnabled();
      await control.setEnabled(next);
      this.bus.emit({
        type: "privacy_action_settled",
        message: next ? "privacy shield on" : "privacy shield off",
      });
    } catch {
      this.bus.emit({
        type: "privacy_action_settled",
        error: "could not switch privacy shield",
      });
    }
    this.refresh();
  }

  /** Flip analytics to the opposite of the live config value (settings tab). */
  async toggleAnalytics(): Promise<void> {
    await this.setAnalyticsEnabled(!getConfig().analytics.enabled, "settings");
  }

  /**
   * Persist `analytics.enabled = enabled`, invalidate the config cache,
   * then hot-swap the runtime clients. Fire-safe: a failure surfaces as a
   * sticky error line and the settled action clears `busy`. `via` says
   * where an opt-out came from, for the `analytics_disabled` event.
   */
  async setAnalyticsEnabled(
    enabled: boolean,
    via: AnalyticsDisabledVia = "settings",
  ): Promise<void> {
    this.bus.emit({ type: "privacy_action_started" });
    try {
      persistAnalyticsEnabled(enabled);
      await this.runtime.setAnalyticsEnabled(enabled, via);
      this.bus.emit({
        type: "privacy_action_settled",
        message: enabled ? "analytics enabled" : "analytics disabled",
      });
      this.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit({
        type: "privacy_action_settled",
        error: `analytics toggle failed: ${msg}`,
      });
      this.bus.emit({
        type: "runtime_info",
        line: `privacy: analytics toggle failed: ${msg}`,
      });
    }
  }
}
