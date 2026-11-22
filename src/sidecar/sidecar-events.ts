/**
 * Typed schema for the NDJSON protocol between the Tauri host and the sidecar.
 * This file is the single source of truth; it is exported through the package
 * root so a Tauri UI written in TypeScript can import the same types.
 */

import type { ApprovalCategory } from "../approval/approval-level.js";
import type { RiskLevel } from "../approval/risk-review.js";
import type { UserQuestion } from "../approval/user-question.js";
import type { ProjectGateView } from "../session/project-gate-view.js";
import type { ProjectEdits, ProjectGate, ProjectVerdict } from "../session/session-project.js";
import type { ProjectRow } from "../cli/projects-command.js";

export type HostRequestType =
  | "start_session"
  | "run_step"
  | "send_message"
  | "steer_message"
  | "cancel"
  | "approval_response"
  | "get_session"
  | "compact_session"
  | "get_compaction"
  | "get_provider_restriction"
  | "get_project"
  | "project_decision"
  | "project_backlog_decision"
  | "list_projects"
  | "forget_project"
  | "resume_project"
  | "get_project_problem"
  | "skill_install"
  | "skill_uninstall"
  | "skill_list"
  | "shutdown"
  | "ping";

export type SidecarEventType =
  | "budget_notice"
  | "project_gate"
  | "fusion_director_notice"
  | "compaction_started"
  | "compaction_progress"
  | "compaction_completed"
  | "compaction_failed"
  | "session_started"
  | "step_started"
  | "step_finished"
  | "tool_call_started"
  | "tool_call_result"
  | "user_message"
  | "steer_applied"
  | "steer_undelivered"
  | "assistant_reply"
  | "assistant_delta"
  | "reasoning_delta"
  | "plan_updated"
  | "turn_started"
  | "turn_finished"
  | "approval_request"
  | "llm_request"
  | "llm_response"
  | "llm_unavailable"
  | "session_completed"
  | "session_failed"
  | "skill_registry_updated"
  | "log"
  | "metric"
  | "trace"
  | "pong"
  | "error";

export interface HostRequest<
  TType extends HostRequestType = HostRequestType,
  TPayload = unknown,
> {
  kind: "request";
  id: string;
  type: TType;
  payload: TPayload;
}

export interface SidecarEvent<
  TType extends SidecarEventType = SidecarEventType,
  TPayload = unknown,
> {
  kind: "event";
  id: string;
  type: TType;
  correlationId?: string;
  payload: TPayload;
}

export interface SidecarResponse<TPayload = unknown> {
  kind: "response";
  id: string;
  correlationId: string;
  ok: boolean;
  payload: TPayload;
  error?: { message: string; code?: string };
}

export type SidecarMessage = HostRequest | SidecarEvent | SidecarResponse;

export interface StartSessionPayload {
  workingDir: string;
  metadata?: Record<string, unknown>;
  /** What the host draws; see {@link StartSessionCapabilities}. */
  capabilities?: StartSessionCapabilities;
}

/**
 * The host's surface, declared once per session on `start_session`.
 * Fixed for the session: it shapes the session's stable prompt prefix.
 */
export interface StartSessionCapabilities {
  /**
   * Issue #39: the host draws the fusion project card (`project_gate`)
   * and answers it with `project_decision`, so the session runs the
   * project flow (brief, plan, milestones). Absent or not `true`: no
   * project tools, and the fan-out asks for approval as before.
   */
  project?: boolean;
}

export interface RunStepPayload {
  sessionId: string;
}

export interface SendMessagePayload {
  sessionId: string;
  text: string;
  maxSteps?: number;
  /**
   * A fusion team director (`"<providerId>:<model>"`, issue #37) to stamp
   * on the session before this turn; it must be one of
   * `llm.runMode.fusion.team.directors`, else the request fails. Omit to
   * keep the session's director (or let the runtime pick one, said in a
   * `fusion_director_notice` event).
   */
  director?: string;
  /** The session's preferred fusion worker, stamped the same way; one of the team's workers. */
  worker?: string;
  /**
   * The session's fusion reviewer (issue #71), stamped the same way: one
   * of the team's reviewers, `"none"` for no review in this chat, or
   * `"team"` to clear the chat's choice so the team picks again.
   */
  reviewer?: string;
}

/**
 * Fold a message into the turn already running on `sessionId`. Unlike
 * {@link SendMessagePayload} this never starts a turn and never queues
 * behind one — see §"Mid-turn steering" in README.md. The response's
 * `steered: false` means the session was idle (or the inbox was full)
 * and the host should fall back to `send_message`.
 */
export interface SteerMessagePayload {
  sessionId: string;
  text: string;
}

export interface CancelPayload {
  sessionId: string;
}

export interface ApprovalResponsePayload {
  approvalId: string;
  approved: boolean;
  /**
   * On a deny, the user's own words, if they typed any. The model reads
   * it as what the user said, so a host never sends a label here.
   */
  reason?: string;
  /**
   * With `approved: true`, remember the answer: `session` for the whole
   * category in this chat, `shape` for this command's binary in this
   * chat, `always` to save an allow rule for the project. Send only one
   * the request's `canSession` / `canShape` / `canAlways` allows; any
   * other fails the request and the approval stays pending.
   */
  grant?: "session" | "shape" | "always";
  /**
   * With `grant: "session"`, the site the host showed the grant for:
   * echo the request's `grantHost` (ATO-1474). The agent records the
   * site from its own pending request, never from this field; a value
   * that is not the request's own site (another host, a request whose
   * grant is not per site, or a non-session grant) fails the request
   * and the approval stays pending. Absent behaves as before: the
   * session grant takes the request's own scope.
   */
  grantHost?: string;
  /**
   * With `approved: true` on a `user_question` request (ATO-489): option
   * labels or 0-based indexes picked, and/or the person's own words. An
   * answer the question does not take fails the request; it stays open.
   */
  answer?: { selected?: Array<string | number>; other?: string };
}

export interface GetSessionPayload {
  sessionId: string;
}

/** `compact_session`: `instructions` (ATO-661) says what the summary must keep. */
export interface CompactSessionPayload extends GetSessionPayload {
  instructions?: string;
}

export interface SkillInstallPayload {
  sourcePath: string;
  force?: boolean;
  /**
   * The folder is security-scanned first. A `caution` verdict fails the
   * request (the message names the findings and ends with
   * `[scanId <id>]`) unless `confirm` is that id; a `dangerous` one fails
   * unless `acknowledgeRisk` is. An id from an older scan, or `true`, is
   * not a yes: if the folder changed, the request fails with the new id.
   */
  confirm?: string;
  acknowledgeRisk?: string;
}

export interface SkillUninstallPayload {
  name: string;
}

export interface ApprovalRequestPayload {
  approvalId: string;
  sessionId: string;
  tool: string;
  /**
   * Which ladder category triggered the prompt (`fs_write_home`,
   * `trust_config`, `shell`, …). Optional for back-compat: hosts built
   * against the pre-ladder protocol ignore it, newer hosts render it so
   * the operator sees *why* the prompt fired instead of guessing from the
   * tool name. Use `formatApprovalCategory` for a display label.
   */
  category?: ApprovalCategory;
  reason: string;
  /** Human-readable preview of the action (diff snippet, command, URL, etc.). */
  preview?: string;
  affectedResources?: string[];
  /** The binary a `shape` grant would cover (`git`); shell requests only. */
  commandShape?: string;
  /** What smart approval's risk review said, when it ran. */
  riskNote?: string;
  riskLevel?: RiskLevel;
  /** The reviewer's reason alone, for `formatRiskLine` (ATO-1268). */
  riskReason?: string;
  /**
   * Whether `grant: "session"` may be offered (the TUI's `[s]`). This
   * agent always sends the three `can*` flags; absent (an older agent)
   * reads as `false`.
   */
  canSession?: boolean;
  /**
   * When `canSession` and the session grant covers one site rather than
   * the whole category (ATO-1474): the host of a browser submit or
   * off-site request (`shop.example`), or the origin of an HTTP request
   * (`https://api.example.com`). A host labels the choice with it ("Allow
   * on shop.example in this chat") and may echo it back as the
   * response's `grantHost`. Absent means the grant covers the category.
   */
  grantHost?: string;
  /** Whether `grant: "shape"` may be offered (the TUI's `[a]`). */
  canShape?: boolean;
  /** Whether `grant: "always"` may be offered ("Allow always"). */
  canAlways?: boolean;
  /** The text of that choice, when `canAlways`: `Always allow "git status" in this project`. */
  alwaysLabel?: string;
  /**
   * Set on a `user_question` request (`ask_user`, ATO-489): draw option
   * cards and answer with `approval_response.answer`; a deny skips it.
   */
  question?: UserQuestion;
}

export interface ToolCallStartedPayload {
  sessionId: string;
  stepIndex: number;
  tool: string;
  args: unknown;
  /**
   * Position of this call inside the parent step's batch, when the
   * step emitted multiple parallel tool calls. Optional for back-
   * compat: solo steps omit both fields. Hosts that ignore them
   * continue to render single-call UIs.
   */
  batchIndex?: number;
  batchSize?: number;
}

export interface ToolCallResultPayload {
  sessionId: string;
  stepIndex: number;
  tool: string;
  status: "ok" | "error";
  summary: string;
  /** Mirrors the matching `ToolCallStartedPayload.batchIndex`. */
  batchIndex?: number;
  batchSize?: number;
  truncated?: boolean;
  /**
   * The HTML file an ok `canvas.render` call wrote (ATO-1137), for the
   * host to show as a canvas. Absent for every other call.
   */
  canvas?: {
    path: string;
    title: string;
    kind: "html" | "chart";
    chart?: "bar" | "line" | "area" | "pie" | "table";
    bytes: number;
  };
}

export interface StepStartedPayload {
  sessionId: string;
  stepIndex: number;
}

export interface StepFinishedPayload {
  sessionId: string;
  stepIndex: number;
  tokensUsed: number;
  durationMs: number;
}

export interface UserMessagePayload {
  sessionId: string;
  text: string;
}

/**
 * A mid-turn message reached the model at `stepIndex`. Distinct from
 * `user_message`, which marks the message that opened the turn — hosts
 * render this one inline inside the running turn.
 */
export interface SteerAppliedPayload {
  sessionId: string;
  text: string;
  stepIndex: number;
}

/**
 * A steer was accepted but the turn ended before the loop could drain
 * it (it landed during the final inference, or the turn was cancelled).
 * The host owns it now — re-send it as a `send_message` if it still
 * makes sense. Emitted rather than silently dropped so "the message you
 * sent always goes somewhere" holds on this surface too.
 */
export interface SteerUndeliveredPayload {
  sessionId: string;
  text: string;
}

export interface AssistantReplyPayload {
  sessionId: string;
  text: string;
  /** Absolute paths of files the reply delivered (`reply.attachments`); absent when none. */
  attachments?: readonly string[];
  /**
   * An interim message: the model batched this reply with work tools and
   * the turn went on. Another `assistant_reply` follows; hosts that show
   * the turn's answer should not take this one for it. Absent otherwise.
   */
  progressNote?: true;
}

/**
 * Incremental slice of the assistant's reply, emitted as `reply.args.text`
 * is streamed out of llama-server. Multiple `assistant_delta` events are
 * followed by a single terminal `assistant_reply` with the full text.
 * Consumers that render deltas live should ignore the final reply body or
 * diff against their accumulated buffer.
 */
export interface AssistantDeltaPayload {
  sessionId: string;
  text: string;
}

/**
 * Incremental `<think>` reasoning chunk. Only present when the model emits
 * a reasoning prelude. `stepIndex` ties the chunk back to the step event
 * stream; multiple deltas may share the same index.
 */
export interface ReasoningDeltaPayload {
  sessionId: string;
  stepIndex: number;
  text: string;
}

export interface TurnStartedPayload {
  sessionId: string;
  turnIndex: number;
}

export interface TurnFinishedPayload {
  sessionId: string;
  turnIndex: number;
  /**
   * `budget` (issue #29): the fusion turn's USD cap stopped the turn; the
   * final report, when one arrived, was sent as the assistant reply.
   */
  reason: "reply" | "finish" | "max_steps" | "cancelled" | "failed" | "budget";
  stepCount: number;
  durationMs: number;
  /** With reason `budget`: the turn's accounted spend, its cap, and the stop line to show. */
  budget?: { spentUsd: number; capUsd: number; text: string };
}

export interface LlmRequestPayload {
  sessionId: string;
  slotId: number;
  promptTokens: number;
  cacheReused: boolean;
}

export interface LlmResponsePayload {
  sessionId: string;
  completionTokens: number;
  durationMs: number;
}

/** Emitted when llama-server is unreachable at session start (sidecar). */
export interface LlmUnavailablePayload {
  url: string;
  error: string | null;
  mode: "external" | "managed";
  hint: string;
}

export interface SkillRegistryUpdatedPayload {
  installed: Array<{ name: string; source: "global" | "project" }>;
}

export interface LogPayload {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context?: Record<string, unknown>;
}

export interface MetricPayload {
  name: string;
  value: number;
  tags?: Record<string, string>;
}

export interface ErrorPayload {
  message: string;
  code?: string;
  stack?: string;
}

export function isHostRequest(msg: SidecarMessage): msg is HostRequest {
  return msg.kind === "request";
}

export function isSidecarEvent(msg: SidecarMessage): msg is SidecarEvent {
  return msg.kind === "event";
}

export function isSidecarResponse(msg: SidecarMessage): msg is SidecarResponse {
  return msg.kind === "response";
}

/** Context maintenance controls; neither creates a user turn. */
export interface CompactSessionPayload { sessionId: string }
export interface GetCompactionPayload { sessionId: string }

/**
 * `project_gate` (issue #39): a fusion project gate of the active session
 * opened or changed — the whole view the desktop card draws, never a
 * delta. Render the buttons from `view.allowedVerdicts` and the per-row
 * pickers from `view.plan.rows[].selectableWorkers` / `selectableReviewers`.
 */
export interface ProjectGateEventPayload {
  sessionId: string;
  view: ProjectGateView;
}

/** `get_project`: the session's current gate view (`view: null` without a project). */
export interface GetProjectPayload {
  sessionId: string;
  evidence?: boolean;
}

/**
 * `project_decision`: the person's verdict at the open gate, against
 * the `version` of the view they saw. `edits.rows` (plan gate) picks a
 * worker/reviewer per task among the row's `selectableWorkers` /
 * `selectableReviewers`; `edits.note` (≤2000 characters) is a milestone
 * correction (verdict `edit`).
 */
export interface ProjectDecisionPayload {
  sessionId: string;
  gate: ProjectGate;
  version: number;
  verdict: ProjectVerdict;
  edits?: ProjectEdits;
}

/**
 * The answer to `project_decision`. A refusal by the runtime (stale
 * version, other gate, `turn-running`, hard cap, no project) is a
 * successful response with `ok: false`, the runtime's `error.code` and
 * the current view; a malformed payload fails the request instead.
 * `continueMessage`, when not null, is what the host sends next with
 * `send_message` (the gate closed and the director has work).
 */
export type ProjectDecisionResult =
  | { ok: true; view: ProjectGateView; continueMessage: string | null }
  | { ok: false; error: { code: string; message: string }; view?: ProjectGateView };

/**
 * Issue #111 review: `project_backlog_decision`, the person's call on a
 * backlog item (`promoted`, `dropped`, or `open` to take one back),
 * between turns only; it moves no gate. Answered like `project_decision`
 * (a refusal is `ok: false` with the runtime's code), without `continueMessage`.
 */
export interface ProjectBacklogDecisionPayload {
  sessionId: string;
  item: string;
  state: "promoted" | "dropped" | "open";
  expectedFingerprint?: string;
}

export type ProjectBacklogDecisionResult =
  | { ok: true; view: ProjectGateView }
  | { ok: false; error: { code: string; message: string }; view?: ProjectGateView };

/**
 * Issue #109: the fusion projects this machine knows, for a host's project
 * list. Each answer carries `schema: 1`; a later shape bumps it. The rows
 * are `atomic-agent projects list --json`'s: a missing, damaged,
 * unsupported or unreadable folder is a row with its `problem`, never a
 * failure.
 */
export type ProjectListRow = ProjectRow;

/** `list_projects` takes nothing. */
export type ListProjectsPayload = Record<string, never>;

/** `registryProblem`: the list itself could not be read (left as it is); `projects` is then empty. */
export interface ListProjectsResult {
  schema: 1;
  projects: ProjectListRow[];
  registryProblem: string | null;
}

/** `forget_project`: drop an absolute folder from the list. Its files are never touched. */
export interface ForgetProjectPayload {
  folder: string;
}

export interface ForgetProjectResult {
  schema: 1;
  folder: string;
  /** False when the folder was not listed. */
  forgotten: boolean;
}

/**
 * `resume_project`: `atomic-agent project resume` for a listed absolute
 * folder. The newest chat on the folder's project (or a new one bound to
 * it) becomes the active session, with the project flow on; `view` is its
 * gate (`null` without a project view).
 */
export interface ResumeProjectPayload {
  folder: string;
}

/** `not-listed`: the folder is not in the list; `project-unavailable`: its project could not be opened (`message` says why). */
export type ResumeProjectResult =
  | { schema: 1; ok: true; folder: string; name: string; sessionId: string; created: boolean; view: ProjectGateView | null }
  | { schema: 1; ok: false; folder: string; error: { code: "not-listed" | "project-unavailable"; message: string } };

/** `get_project_problem`: why a session's project did not open (`problem: null` when it opened or it has none). */
export interface GetProjectProblemPayload {
  sessionId: string;
}

export interface GetProjectProblemResult {
  sessionId: string;
  problem: string | null;
}
