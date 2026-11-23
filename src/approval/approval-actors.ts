import { AsyncLocalStorage } from "node:async_hooks";

/** Names only. Bearer credentials never enter the runtime. */
export interface ApprovalActors {
  sessionId: string;
  requestedByToken: string | undefined;
  steeredByTokens: Set<string>;
}

export const approvalActors = new AsyncLocalStorage<ApprovalActors>();
