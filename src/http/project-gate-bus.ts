import type { AgentLoopEvent } from "../agent/agent-contract.js";

export type ProjectGateEvent = Extract<AgentLoopEvent, { type: "project_gate" }>;
export type ProjectGateListener = (event: ProjectGateEvent) => void;

/** The most sessions whose open gate the mirror keeps for a reconnect (oldest first out). */
export const MAX_MIRRORED_PROJECT_GATES = 100;

/**
 * In-process pub/sub for fusion project gates (issue #39), like
 * {@link ApprovalBus}: serve wires the runtime's `project_gate` events
 * here and every `GET /api/events` stream forwards them. The newest view
 * of each session with an open gate is kept, so a reconnecting window
 * draws its card again; a view whose gate is `none` drops the session.
 */
export class ProjectGateBus {
  private readonly listeners = new Set<ProjectGateListener>();
  private readonly open = new Map<string, ProjectGateEvent>();

  publish(event: ProjectGateEvent): void {
    this.open.delete(event.sessionId);
    if (event.view.gate.kind !== "none") {
      this.open.set(event.sessionId, event);
      if (this.open.size > MAX_MIRRORED_PROJECT_GATES) {
        const oldest = this.open.keys().next().value;
        if (oldest !== undefined) this.open.delete(oldest);
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Best-effort to consumers, as approvals are.
      }
    }
  }

  /** The open gates, oldest first. */
  snapshot(): ProjectGateEvent[] {
    return [...this.open.values()];
  }

  subscribe(listener: ProjectGateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
