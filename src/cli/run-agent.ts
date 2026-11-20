import { statSync } from "node:fs";
import { resolve } from "node:path";

import {
  formatApprovalCategory,
  formatApprovalLevel,
  formatNeverGrantedNote,
  resolveBootApprovalLevel,
} from "../approval/approval-level.js";
import { getConfig } from "../config/index.js";
import {
  formatLlamaUnreachableHint,
  formatLlamaWrongServerHint,
  llamaWrongServerStatus,
} from "../llm/llama-server-health.js";
import {
  LOCAL_ENGINE_START_HINT,
  LOCAL_SERVER_NOT_FOUND_CODE,
  classifyLocalServerError,
  isLocalEngineDown,
  localServerErrorLines,
  turnBudgetStopLine,
} from "../llm/reliability/index.js";
import { resolveLlmConfig } from "../llm/provider/registry/provider-types.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import type { AgentLoopEvent } from "../agent/agent-contract.js";
import {
  canGrantCategory,
  describeCategoryGrant,
  describeMcpToolGrant,
  canGrantShape,
  type ApprovalGrantScope,
  type ApprovalRequest,
} from "../approval/approval-gate.js";
import {
  canGrantAlways,
  describeAlwaysRule,
} from "../approval/approval-rules.js";
import { siteGrantHost } from "../approval/site-grants.js";
import type { UserQuestionAnswer } from "../approval/user-question.js";
import {
  cliShowsQuestions,
  formatCliQuestionPrompt,
  promptCliQuestion,
} from "./cli-user-question.js";
import { formatSkillCatalogOmittedNote } from "../skills/index.js";
import { createStderrSink } from "../tracing/structured-logger.js";
import {
  isFailedSessionStatus,
  type SessionState,
} from "../session/session-state.js";
import { findConstraintRefusal, formatConstraintRefusal } from "../runtime/constraint-refusal.js";
import {
  createStdinLineQueue,
  type StdinLineQueue,
} from "./stdin-line-queue.js";
import { parseAllowedCommand, pinAllowedCommand, type AllowedCommand } from "./run-allowed-command.js";
import { PROJECT_GATE_EXIT, settleProjectGate } from "./run-project-gate.js";
import { withProject } from "../session/session-project.js";

interface RunArgs {
  workingDir: string;
  maxSteps: number | null;
  noApproval: boolean;
  /** ATO-586: an incognito chat, deleted when the run ends. */
  incognito: boolean;
  /** Issue #37: `--director`, the session's fusion director; null lets the runtime pick (and say which). */
  director: string | null;
  /** Issue #71: `--reviewer`, the session's fusion reviewer, or "none". */
  reviewer: string | null;
  /** Issue #37: `--worker`, the session's preferred fusion worker. */
  worker: string | null;
  /** Issue #39: `--session`, continue this stored chat. */
  session: string | null;
  /** Issue #39: `--approve <version>`, approve the session's open project gate first. */
  approve: boolean;
  /** The version `--approve` names; null when bare (the run shows the gate and asks for it). */
  approveVersion: number | null;
  /** Issue #39: `--auto-approve-project`, approve every project gate as it opens (explicit only). */
  autoApproveProject: boolean;
  /** Issue #95: `--allow-command "<exact command>"` (repeatable), pre-approved in `--cwd` or below. */
  allowCommands: AllowedCommand[];
}

const HELP =
  [
    "atomic-agent run — chat with the agent over stdin",
    "",
    "Usage:",
    "  atomic-agent run [options]           interactive: one message per line",
    '  echo "<goal>" | atomic-agent run     one-shot: answer on stdout, logs on stderr',
    "                                       (each piped line is a separate turn)",
    "",
    "Options:",
    "  --cwd <dir>          Working directory for OS tools (default: current directory)",
    "  --working-dir <dir>  Alias for --cwd",
    "  --max-steps <n>      Hard step ceiling for one task (default: agent.task.maxSteps)",
    "  --no-approval        Force approval level 5: auto-approve every dangerous tool call",
    "  --incognito          Incognito chat: nothing is saved to memory, the chat is deleted when the run ends",
    "  --director <member>  Fusion director for this chat, one of llm.runMode.fusion.team.directors",
    "                       (\"<providerId>:<model>\"); default: the only one available, else the team's default",
    "  --worker <member>    Preferred fusion worker for this chat, one of the team's workers",
    "  --reviewer <member>  Fusion reviewer for this chat, one of the team's reviewers, \"none\" for no review, or \"team\" to let the team pick",
    "  --session <id>       Continue this stored chat",
    "  --approve <version>  Approve the chat's open fusion project gate (brief, plan or milestone)",
    "                       at the version printed with it, then continue; needs --session",
    "  --auto-approve-project",
    "                       Approve every fusion project gate at its current version as it opens,",
    "                       printing each with its version (scripts only); a failed milestone",
    "                       stops the run (exit 3) for a person",
    '  --allow-command "<command>"',
    "                       Run exactly this one command (e.g. the project's test command) without",
    "                       asking, as a direct exec with these exact words in --cwd or below;",
    "                       repeatable. Any other command, or the same line through a shell, still",
    "                       asks; never implied by --auto-approve-project. It also answers a saved",
    "                       \"ask\" rule for that command. A test runner (node --test, npm test)",
    "                       runs whatever test files it finds, so allowing one allows any code the",
    "                       model can write into --cwd",
    "",
    "In-session:  /quit exits · /abort cancels the current turn",
    "Exit codes:  0 replied · 1 failed · 2 usage error · 3 waiting at a project gate (session id printed)",
  ].join("\n") + "\n";

export function parseRunArgs(
  args: string[],
): RunArgs | { error: string } | { help: true } {
  let workingDir: string | null = null;
  let maxSteps: number | null = null;
  let noApproval = false;
  let incognito = false;
  let director: string | null = null;
  let worker: string | null = null;
  let reviewer: string | null = null;
  let session: string | null = null;
  let approve = false;
  let approveVersion: number | null = null;
  let autoApproveProject = false;
  const allowCommands: AllowedCommand[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    switch (flag) {
      case "--help":
      case "-h":
        return { help: true };
      case "--cwd":
      case "--working-dir": {
        const value = args[++i];
        if (!value) return { error: `${flag} requires a value` };
        const resolved = resolve(value);
        // A typo'd path used to sail through: the run booted, printed the
        // bogus directory in its banner as though healthy, ENOENT'd on
        // every filesystem tool until the step budget ran out — and then
        // exited 0. Catch it before anything boots.
        let isDirectory = false;
        try {
          isDirectory = statSync(resolved).isDirectory();
        } catch {
          isDirectory = false;
        }
        if (!isDirectory) {
          return { error: `${flag} is not a directory: ${resolved}` };
        }
        workingDir = resolved;
        break;
      }
      case "--max-steps": {
        const value = args[++i];
        const parsed = value ? Number.parseInt(value, 10) : NaN;
        if (!Number.isFinite(parsed))
          return { error: "--max-steps expects an integer" };
        maxSteps = parsed;
        break;
      }
      case "--no-approval":
        noApproval = true;
        break;
      case "--incognito":
        incognito = true;
        break;
      case "--session": {
        const value = args[++i];
        if (!value) return { error: "--session requires a value" };
        session = value;
        break;
      }
      case "--approve": {
        approve = true;
        const value = args[i + 1];
        if (value !== undefined && /^\d+$/.test(value)) {
          approveVersion = Number(value);
          i += 1;
        }
        break;
      }
      case "--auto-approve-project":
        autoApproveProject = true;
        break;
      case "--allow-command": {
        const value = args[++i];
        if (value === undefined) return { error: "--allow-command requires a command" };
        const command = parseAllowedCommand(value);
        if ("error" in command) return { error: command.error };
        allowCommands.push(command);
        break;
      }
      case "--reviewer": {
        const value = args[++i];
        if (!value) return { error: `${flag} requires a value` };
        const colon = value.indexOf(":");
        if (value !== "none" && value !== "team" && (colon <= 0 || colon === value.length - 1)) {
          return { error: `${flag} expects "<providerId>:<model>", "none" or "team"` };
        }
        reviewer = value;
        break;
      }
      case "--director":
      case "--worker": {
        const value = args[++i];
        if (!value) return { error: `${flag} requires a value` };
        const colon = value.indexOf(":");
        if (colon <= 0 || colon === value.length - 1) return { error: `${flag} expects "<providerId>:<model>"` };
        if (flag === "--director") director = value;
        else worker = value;
        break;
      }
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  if (approve && session === null) return { error: "--approve needs --session <id>" };
  if (session !== null && incognito) return { error: "--session and --incognito cannot be combined" };
  return {
    workingDir: workingDir ?? process.cwd(),
    maxSteps,
    noApproval,
    incognito,
    director,
    worker,
    reviewer,
    session,
    approve,
    approveVersion,
    autoApproveProject,
    allowCommands,
  };
}

interface CliApprovalAnswer {
  approved: boolean;
  /**
   * Issue #95: nobody could be asked (stdin ended, or a non-interactive
   * stdin's next line was a message, not an answer). Resolved as an
   * `automatic` denial, so the model is never told the user declined.
   */
  unavailable?: true;
  grant?: ApprovalGrantScope;
  /** The answer to an `ask_user` question (`cli-user-question.ts`). */
  answer?: UserQuestionAnswer;
}

/**
 * The text `promptApproval` writes before reading the answer: what is
 * asked, the grant options this request allows, and — when the category
 * can never be granted for the session — a note naming that category.
 */
export function formatCliApprovalPrompt(request: ApprovalRequest): string {
  if (request.question) return formatCliQuestionPrompt(request.question);
  const grantCategory = canGrantCategory(request);
  const grantShape = canGrantShape(request);
  const lines = [
    "",
    `» approval required for tool: ${request.tool}`,
    `  kind: ${formatApprovalCategory(request.category)}`,
    `  reason: ${request.reason}`,
  ];
  if (request.preview) lines.push(`  preview: ${request.preview}`);
  if (request.affectedResources?.length) {
    lines.push(`  affects: ${request.affectedResources.join(", ")}`);
  }
  const options = ["y = approve once"];
  if (grantCategory) {
    options.push(
      siteGrantHost(request) !== null
        ? `s = allow ${describeCategoryGrant(request)} this session`
        : describeMcpToolGrant(request) !== null
          ? `s = allow ${describeMcpToolGrant(request)} this session`
        : request.grantKey !== undefined
          ? `s = allow this kind to ${request.grantKey} this session`
        : "s = allow this kind this session",
    );
  }
  if (grantShape) {
    options.push(`a = allow all ${request.commandShape} this session`);
  }
  // Saved, unlike the two above (ATO-1142).
  if (canGrantAlways(request)) {
    options.push(`w = ${describeAlwaysRule(request)}`);
  }
  options.push("N = deny");
  if (!grantCategory) {
    lines.push(`  (${formatNeverGrantedNote(request.category)})`);
  }
  lines.push(`  approve? [${options.join(", ")}] `);
  return lines.join("\n");
}

/**
 * Whether a stdin line answers an approval prompt: one of the offered
 * keys (`y`, `s`, `a`, `w`, `n`), `yes` / `no`, or an empty line (Enter,
 * the default `N`), in any case. Anything else is a message for the
 * agent, not an answer.
 */
export function isApprovalAnswer(line: string): boolean {
  return /^(y|yes|n|no|s|a|w|)$/.test(line.trim().toLowerCase());
}

/**
 * Interactive approval over stdin. We ask the operator to confirm each
 * dangerous action; `y`/`yes` approves this call, `s` also grants the
 * category for the session, `a` grants this shell command shape, `w`
 * saves an "always allow" rule for this project (`canGrantAlways`).
 * Any other answer (`n`, `no`, Enter, a grant key this request does not
 * offer) is a refusal. The grant options mirror the TUI prompt;
 * they are offered here too because a CLI operator has the same physical
 * access to the machine. A category that is never grantable
 * (`isGrantableCategory`: trust config, e-mail, fusion fan-out) only
 * ever shows `y/N`.
 *
 * The answer is the next line of the same stdin queue the chat loop
 * reads (ATO-802), so a piped "y" written together with the next
 * message answers this prompt and the message stays queued for the
 * next turn. Only a line shaped like an answer (`isApprovalAnswer`) is
 * taken: any other line stays queued as the next message, so a driver
 * that pipes "task\ncontinue" without answering loses nothing to the
 * prompt. EOF before an answer, or (when stdin is not a terminal) a
 * line that is not an answer, means nobody could be asked: the call is
 * refused as `unavailable`, never as the user's decision (issue #95). A
 * non-answer typed at a terminal stays a refusal, as before.
 */
async function promptApproval(
  request: ApprovalRequest,
  lines: StdinLineQueue,
  interactive: boolean,
): Promise<CliApprovalAnswer> {
  const grantCategory = canGrantCategory(request);
  const grantShape = canGrantShape(request);
  process.stderr.write(formatCliApprovalPrompt(request));
  if (request.question) {
    return promptCliQuestion(request.question, lines, (text) => process.stderr.write(text));
  }
  const head = await lines.peek();
  if (head === null) {
    process.stderr.write(`\n  ${APPROVAL_UNAVAILABLE}: stdin ended before an answer; not run\n`);
    return { approved: false, unavailable: true };
  }
  if (!isApprovalAnswer(head)) {
    if (!interactive) {
      process.stderr.write(
        `\n  ${APPROVAL_UNAVAILABLE}: the next input line is not an answer, kept as the next message; not run\n`,
      );
      return { approved: false, unavailable: true };
    }
    process.stderr.write(
      "\n  denied: the next input line is not an answer, kept as the next message\n",
    );
    return { approved: false };
  }
  await lines.next();
  const answer = head.trim().toLowerCase();
  if (answer === "s" && grantCategory) {
    process.stderr.write(
      `\n  granted: ${formatApprovalCategory(request.category)} for this session\n`,
    );
    return { approved: true, grant: "category" };
  }
  if (answer === "a" && grantShape) {
    process.stderr.write(
      `\n  granted: ${request.commandShape} commands for this session\n`,
    );
    return { approved: true, grant: "shape" };
  }
  if (answer === "w" && canGrantAlways(request)) {
    process.stderr.write(
      `\n  saved: ${describeAlwaysRule(request)} (approval-rules.json in the agent's state folder)\n`,
    );
    return { approved: true, grant: "always" };
  }
  return { approved: /^(y|yes)$/.test(answer) };
}

/** Issue #95: what an approval nobody could be asked is called, on stderr and to the model. */
export const APPROVAL_UNAVAILABLE = "approval unavailable (non-interactive run)";

/** The denial reason the model reads for an unavailable approval: nobody declined. */
const APPROVAL_UNAVAILABLE_REASON =
  `${APPROVAL_UNAVAILABLE}: no answer could be read from stdin, so nobody was asked and nobody declined it. ` +
  "Report it as not run for that reason, not as refused by the user";

/**
 * The unavailable reason, plus (issue #95) the commands `--allow-command`
 * pre-approves, so the model can retry in exactly that form.
 */
function unavailableReason(allowed: readonly AllowedCommand[], argv: readonly string[] | undefined, notPinned: string | null): string {
  if (allowed.length === 0) return APPROVAL_UNAVAILABLE_REASON;
  if (notPinned !== null) {
    return `${APPROVAL_UNAVAILABLE_REASON}. It is the allowed command \`${(argv ?? []).join(" ")}\`, but ${notPinned}, so it cannot run unattended`;
  }
  const listed = allowed.map((command) => `\`${command.argv.join(" ")}\``).join(", ");
  return `${APPROVAL_UNAVAILABLE_REASON}. This run pre-approves only ${listed}, run as exactly those words in its folder`;
}

/** Transport failures that mean "nothing answered at the configured URL". */
const TRANSPORT_NO_ANSWER =
  /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|timeout/i;

/** What `formatAgentEvent` needs to decorate a local-route failure. */
export interface LlamaHintContext {
  /** `formatLlamaUnreachableHint(url)`, or null off the local route. */
  llamaHint?: string | null;
  /**
   * `localModels.url`, set together with `llamaHint`: names the address
   * in the wrong-server line when llama-server answered 404/405.
   */
  llamaUrl?: string | null;
  hintShown?: { value: boolean };
  /** A local model is configured: a constraint refusal offers switching to it. */
  localModelConfigured?: boolean;
}

/**
 * The hint for this failure, or null. A llama-server that answered
 * 404/405 is running, so it gets "wrong server or no model loaded"
 * rather than "start it" (ATO-870); a transport error where nothing
 * answered keeps the unreachable hint.
 */
function pickLlamaHint(
  category: string,
  message: string,
  ctx: LlamaHintContext,
): string | null {
  if (category !== "transport" || !ctx.llamaHint) return null;
  const status = llamaWrongServerStatus(message);
  if (status !== null) {
    return ctx.llamaUrl ? formatLlamaWrongServerHint(ctx.llamaUrl, status) : null;
  }
  return TRANSPORT_NO_ANSWER.test(message) ? ctx.llamaHint : null;
}

function withLlamaHint(
  base: string,
  category: string,
  message: string,
  ctx?: LlamaHintContext,
): string {
  if (!ctx || ctx.hintShown?.value) return base;
  const hint = pickLlamaHint(category, message, ctx);
  if (hint === null) return base;
  if (ctx.hintShown) ctx.hintShown.value = true;
  const indented = hint
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return `${base}\n${indented}`;
}

/**
 * Render one agent-loop event as a diagnostic stderr line, or null for
 * events other surfaces own. Exported for tests.
 *
 * `ctx.llamaHint` carries the actionable llama-server message when the
 * active text route is the local server: a transport failure there is
 * almost always "llama-server is not running", and the raw undici string
 * ("fetch failed") tells the operator none of URL / cause / fix. The hint
 * is appended once per process — every retry repeating three lines of
 * advice would bury the log.
 */
export function formatAgentEvent(
  event: AgentLoopEvent,
  ctx?: LlamaHintContext,
): string | null {
  switch (event.type) {
    case "budget_notice":
    case "fusion_director_notice":
      return `» ${event.text}`;
    case "user_message":
      return null;
    case "turn_started":
      return `» turn ${event.turnIndex} started`;
    case "turn_finished":
      // Issue #29: say why a turn its fusion USD cap stopped ended there.
      if (event.reason === "budget" && event.budget !== undefined) {
        return `» ${turnBudgetStopLine(event.budget.spentUsd, event.budget.capUsd)} (turn ${event.turnIndex}, ${event.stepCount} steps, ${event.durationMs}ms)`;
      }
      return `» turn ${event.turnIndex} ${event.reason} (${event.stepCount} steps, ${event.durationMs}ms)`;
    case "step_started":
      return `[step ${event.stepIndex}] started`;
    case "step_finished":
      return `[step ${event.stepIndex}] ${event.summary} (${event.durationMs}ms)`;
    case "llm_event": {
      const inner = event.event;
      if (inner.type === "tool_call_parsed") {
        return `  → ${inner.call.tool}(${JSON.stringify(inner.call.args)})`;
      }
      if (inner.type === "tool_call_executed") {
        return `  ← ${inner.result.tool} ${inner.result.status}: ${inner.result.summary}${inner.result.truncated ? " (truncated)" : ""}`;
      }
      if (inner.type === "step_error") {
        const base = `  ! [${inner.category}] ${inner.error.message}`;
        return withLlamaHint(base, inner.category, inner.error.message, ctx);
      }
      // assistant_reply / reasoning are emitted to stdout from the chat loop instead.
      return null;
    }
    case "loop_completed":
      return null;
    case "loop_failed": {
      // A per-folder constraint refused the turn: the same sentence and
      // hint as the TUI and the stable code, never a provider failure.
      const constraint = findConstraintRefusal(event.error);
      if (constraint !== null) {
        const text = formatConstraintRefusal(constraint, { localModelConfigured: ctx?.localModelConfigured ?? false });
        return `» turn stopped [${constraint.code}]: ${text.split("\n").join("\n  ")}`;
      }
      const base = `» loop failed [${event.category}]: ${event.error.message}`;
      // ATO-772: the managed local model's process is gone; the turn ended
      // without waiting, and the fix is one command.
      if (isLocalEngineDown(event.error)) return `${base}\n    ${LOCAL_ENGINE_START_HINT}`;
      // ATO-707 / ATO-737: a local server's typed 400 in plain words. A
      // 404/405 keeps the wrong-server hint, which names `models check`.
      const local = classifyLocalServerError(event.error);
      if (local !== null && local.code !== LOCAL_SERVER_NOT_FOUND_CODE) {
        // An OpenAI-compatible server's message already says it
        // (`humanizeOpenAiHttpError`); saying it twice helps nobody.
        if (event.error.message.includes(local.message)) return base;
        return [base, ...localServerErrorLines(local).map((line) => `    ${line}`)].join("\n");
      }
      return withLlamaHint(base, event.category, event.error.message, ctx);
    }
    default:
      return null;
  }
}

/**
 * The `skills:` row of the startup banner. `installed` has always been
 * `runtime.skillCatalog.length`, which is the catalog the prompt got,
 * not the number of skills on disk — so on an install big enough to
 * overflow `skills.catalogTokenBudget` the banner quietly understated
 * itself and the operator had no hint that anything was missing
 * (issue #466, whose fix stopped at the prompt).
 *
 * Nothing dropped renders byte-identically to the pre-fix banner: the
 * suffix is the whole change, and it is absent at zero.
 */
export function formatSkillsBannerValue(
  installed: number,
  dropped: number,
): string {
  const base = `${installed} installed`;
  return dropped > 0
    ? `${base}, ${formatSkillCatalogOmittedNote(dropped)}`
    : base;
}

interface ChatLoopOptions {
  runtime: AgentRuntime;
  initialSession: SessionState;
  /**
   * `--max-steps`, when given: a hard ceiling for each task. Absent, no
   * `maxSteps` is passed and the runtime runs legs of `agent.maxSteps`
   * up to the `agent.task.maxSteps` ceiling.
   */
  maxSteps?: number;
  /**
   * `--director` / `--worker` (issue #37): sent with the first turn, which
   * stamps them on the session; later turns keep the stamp.
   */
  team?: { director?: string; worker?: string; reviewer?: string };
  controller: AbortController;
  /** Stdin lines, shared with the approval prompt. */
  lines: StdinLineQueue;
  /** Whether turns are offered `ask_user` (`cliShowsQuestions`). */
  questions: boolean;
  /**
   * Stdin is piped, not a terminal. A piped multi-line prompt still runs
   * one turn per line, so the first time a second line becomes its own
   * turn a one-line notice goes to stderr (ATO-910).
   */
  piped: boolean;
  /**
   * Fusion project gates (issue #39): `approveFirst` approves the
   * session's open gate before reading stdin (`--approve`); `auto`
   * approves every gate as it opens (`--auto-approve-project`).
   * Otherwise the loop stops at a gate and the run exits 3.
   */
  projectGate?: { approveFirst: boolean; approveVersion?: number | null; auto: boolean };
}

interface ChatLoopResult {
  session: SessionState;
  /** Why the loop stopped early at a project gate, when it did. */
  projectGate?: "waiting" | "refused";
}

/**
 * The stderr notice for piped stdin whose second line became a separate
 * turn: a multi-line prompt is not read as one message.
 */
export const STDIN_LINE_PER_TURN_NOTICE =
  "stdin: each line is sent as a separate turn; join a multi-line prompt into one line to send it as one message";

/**
 * Read messages line-by-line from stdin and feed them through
 * `runtime.runTurn`. Assistant replies go to stdout (so a pipe captures
 * just the human-readable text); everything else stays on stderr. The
 * loop ends on EOF, `/quit`, or abort.
 */
async function runChatLoop(opts: ChatLoopOptions): Promise<ChatLoopResult> {
  let session = opts.initialSession;

  const collectReply = (): {
    onEvent: (e: AgentLoopEvent) => void;
    getReply: () => string | null;
  } => {
    let reply: string | null = null;
    return {
      onEvent: (event) => {
        // One stdout line per turn: the reply that ended it, never a
        // progress note the model batched with work along the way.
        if (
          event.type === "llm_event" &&
          event.event.type === "assistant_reply" &&
          event.event.progressNote !== true
        ) {
          reply = event.event.text;
        }
      },
      getReply: () => reply,
    };
  };

  let team = opts.team;
  const driveTurn = async (message: string): Promise<void> => {
    const collector = collectReply();
    const firstTeam = team;
    team = undefined;
    const result = await opts.runtime.runTurn(session, message, {
      ...(opts.maxSteps === undefined ? {} : { maxSteps: opts.maxSteps }),
      ...firstTeam,
      signal: opts.controller.signal,
      origin: "cli",
      questions: opts.questions,
      eventHook: collector.onEvent,
    });
    session = result.session;
    const reply = collector.getReply();
    if (reply !== null) {
      // Collapse embedded newlines into spaces so the "exactly one
      // stdout line per turn" invariant holds even when the model
      // emits markdown bullet lists or other multi-line content. A
      // line-synchronised driver (`eval-memory/harness/multi-turn-driver.ts`)
      // splits stdout on `\n` and feeds extra lines into its backlog,
      // which on the next prompt resolve *immediately* as fake replies
      // and slide the prompt↔reply pairing by one slot per embedded
      // newline. Reply text destined for analysis lives in the trace
      // file (`tool_invocation.args.text`); stdout is purely a sync
      // channel, so flattening newlines does not lose data.
      const singleLine = reply.replace(/\r?\n/g, " ");
      process.stdout.write(`${singleLine}\n`);
    } else {
      // No assistant_reply was emitted this turn (failed / cancelled /
      // max_steps with no reply). Still write a single newline so the
      // "exactly one stdout line per turn" invariant holds for any
      // line-synchronised driver — the diagnostic detail already went
      // to stderr via formatAgentEvent.
      process.stdout.write("\n");
    }
  };

  const gate = opts.projectGate ?? { approveFirst: false, auto: false };
  let stoppedAt: ChatLoopResult["projectGate"];
  /**
   * After a turn (or at the start with `--approve`): approve and
   * continue while gates open, or stop at one. False ends the loop.
   */
  const settleGates = async (first: "stop" | "approve" | { version: number }): Promise<boolean> => {
    let mode = first;
    for (;;) {
      if (opts.controller.signal.aborted) return false;
      const step = await settleProjectGate(opts.runtime, session.id, mode);
      if (step.kind === "open") return true;
      if (step.kind === "stop") {
        process.stderr.write(`${step.text}\n`);
        stoppedAt = "waiting";
        return false;
      }
      if (step.kind === "failed") {
        process.stderr.write(`${step.text}\n`);
        stoppedAt = "refused";
        return false;
      }
      process.stderr.write(`project: ${step.line}\n`);
      session = withProject(session, step.project);
      if (step.message === null) return true;
      await driveTurn(step.message);
      mode = gate.auto ? "approve" : "stop";
    }
  };

  let turnsStarted = 0;
  try {
    if (gate.approveFirst) {
      const view = opts.runtime.projectState?.(session.id) ?? null;
      if (view === null || view.gate.kind === "none") {
        process.stderr.write(`project: nothing waits for approval on session ${session.id}\n`);
        stoppedAt = "refused";
        return { session, projectGate: stoppedAt };
      }
      const version = gate.approveVersion ?? null;
      if (version === null) {
        // Approve only what the person read: show the gate and its version.
        const shown = await settleProjectGate(opts.runtime, session.id, "stop");
        if (shown.kind === "stop") process.stderr.write(`${shown.text}\nRepeat with the version to approve it.\n`);
        stoppedAt = "waiting";
        return { session, projectGate: stoppedAt };
      }
      if (!(await settleGates({ version }))) return { session, ...(stoppedAt ? { projectGate: stoppedAt } : {}) };
    }
    while (true) {
      if (opts.controller.signal.aborted) break;
      // Issue #100: the run ends here (the chat finished, or stdin ended).
      // A gate still waiting on the person (a continued chat left at one,
      // say) is said with how to resume and ends the run with its exit
      // code, not a silent 0; auto-approve still takes what it may.
      if (session.status === "completed") {
        await settleGates(gate.auto ? "approve" : "stop");
        break;
      }
      const line = await opts.lines.next("you> ");
      if (line === null) {
        await settleGates(gate.auto ? "approve" : "stop");
        break;
      }
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (trimmed === "/quit" || trimmed === "/exit") break;
      if (trimmed === "/abort") {
        opts.controller.abort();
        break;
      }
      turnsStarted += 1;
      if (opts.piped && turnsStarted === 2) {
        process.stderr.write(`${STDIN_LINE_PER_TURN_NOTICE}\n`);
      }
      await driveTurn(trimmed);
      if (!(await settleGates(gate.auto ? "approve" : "stop"))) break;
    }
  } finally {
    opts.lines.close();
  }
  return { session, ...(stoppedAt ? { projectGate: stoppedAt } : {}) };
}

/**
 * CLI entry for `atomic-agent run`. Pure interactive chat: each stdin
 * line is one user message, each `reply` from the model becomes one
 * assistant message. `/quit` exits, `/abort` cancels the current turn.
 */
export async function runAgentCommand(args: string[]): Promise<number> {
  const parsed = parseRunArgs(args);
  if ("help" in parsed) {
    process.stdout.write(HELP);
    return 0;
  }
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const config = getConfig();
  const approvalLevel = resolveBootApprovalLevel(
    parsed.noApproval,
    config.agent.approvalLevel,
  );

  let approvalChain: Promise<unknown> = Promise.resolve();
  // Created once the runtime is up (a failed boot must not leave stdin
  // open); approvals only arrive during a turn, after that.
  let stdinLines: StdinLineQueue | null = null;

  // The hint only applies when a transport failure means "local llama is
  // down" — i.e. the active text route IS the local server. On a cloud
  // route the same category points at the provider, not at llama.
  const onLocalRoute =
    resolveLlmConfig(config).activeTextProvider === "local-llama";
  const llamaHint = onLocalRoute
    ? formatLlamaUnreachableHint(config.localModels.url)
    : null;
  const llamaUrl = onLocalRoute ? config.localModels.url : null;
  const hintShown = { value: false };
  const localModelConfigured =
    config.localModels.managed.modelId !== null || config.localModels.mode === "external";

  const runtime = await createAgentRuntime({
    workingDir: parsed.workingDir,
    approvalLevel,
    traceDefault: true,
    handlers: {
      onAgentEvent: (event) => {
        // Per-turn assistant-reply collection is wired through the
        // `eventHook` argument of `runTurn` (see `driveTurn`). This
        // global handler only feeds the diagnostic stderr stream so
        // the operator can watch the macro-turn lifecycle.
        const line = formatAgentEvent(event, {
          llamaHint,
          llamaUrl,
          hintShown,
          localModelConfigured,
        });
        if (line) process.stderr.write(`${line}\n`);
      },
      onApprovalRequest: (request) => {
        // A prompt that fails is a refusal, and the chain never stays
        // rejected: a rejected chain would skip every later approval and
        // leave its request unresolved, hanging the turn (ATO-802).
        approvalChain = approvalChain
          .then(async () => {
            let answer: CliApprovalAnswer;
            // Issue #95: the exact command the operator listed, in --cwd
            // or below, runs unasked; everything else asks as before.
            // The approval pins the real program, argv and folder; the
            // tool spawns exactly that (`pinnedExec`).
            const pin = request.question ? null : pinAllowedCommand(request, parsed.allowCommands, parsed.workingDir);
            // The allowed words, but nothing safe to pin: say why, so the
            // model does not retry the same words in vain.
            const notPinned = pin !== null && "refused" in pin ? pin.refused : null;
            const pinnedExec = pin !== null && !("refused" in pin) ? pin : null;
            if (pinnedExec !== null) {
              process.stderr.write(`  approved by --allow-command: ${pinnedExec.argv.join(" ")} (runs ${pinnedExec.file})\n`);
              runtime.approvals.resolve({ approvalId: request.approvalId, approved: true, reason: "cli-allow-command", pinnedExec });
              return;
            }
            try {
              answer =
                stdinLines === null
                  ? { approved: false, unavailable: true }
                  : await promptApproval(request, stdinLines, process.stdin.isTTY === true);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              process.stderr.write(
                `\n  approval prompt failed (${msg}); denied\n`,
              );
              answer = { approved: false, unavailable: true };
            }
            runtime.approvals.resolve({
              approvalId: request.approvalId,
              approved: answer.approved,
              // No reason on a person's deny: it would reach the model as
              // the user's own words (see `ApprovalDecision.reason`). An
              // unavailable approval is the system's, and says so.
              ...(answer.approved ? { reason: "cli-approved" } : {}),
              ...(answer.unavailable ? { automatic: true, unavailable: true, reason: unavailableReason(parsed.allowCommands, request.commandArgv, notPinned) } : {}),
              ...(answer.grant ? { grant: answer.grant } : {}),
              ...(answer.answer ? { answer: answer.answer } : {}),
            });
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`approval could not be resolved: ${msg}\n`);
          });
      },
      onChannelStatus: (status) => {
        const suffix =
          status.lastError && status.state === "down"
            ? `: ${status.lastError}`
            : "";
        process.stderr.write(`[${status.channel}] ${status.state}${suffix}\n`);
      },
      logSinks: [createStderrSink()],
    },
  });

  process.stderr.write(
    `atomic-agent run (chat)\n` +
      `  cwd:     ${parsed.workingDir}\n` +
      `  llama:   ${config.localModels.url}\n` +
      `  browser: ${config.browser.channel}${config.browser.headless ? " (headless)" : ""}\n` +
      `  skills:  ${formatSkillsBannerValue(
        runtime.skillCatalog.length,
        runtime.skillCatalogDropped,
      )}\n` +
      `  approval: level ${formatApprovalLevel(approvalLevel)}\n` +
      `  type /quit to exit, /abort to cancel current turn\n`,
  );

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let exitCode = 0;
  let incognitoSessionId: string | null = null;
  try {
    const stored = parsed.session === null ? null : runtime.sessionStore.load(parsed.session);
    if (parsed.session !== null && stored === null) {
      process.stderr.write(`no stored session ${parsed.session}\n`);
      return 1;
    }
    const session = stored ?? runtime.createSession(
      parsed.incognito ? { incognito: true } : undefined,
    );
    incognitoSessionId = parsed.incognito ? session.id : null;
    stdinLines = createStdinLineQueue({
      input: process.stdin,
      output: process.stderr,
      terminal: process.stdin.isTTY === true,
    });
    const loop = await runChatLoop({
      runtime,
      initialSession: session,
      // Only `--max-steps` becomes a ceiling. Filling in `agent.maxSteps`
      // (the leg length) made every task stop at the first leg.
      ...(parsed.maxSteps === null ? {} : { maxSteps: parsed.maxSteps }),
      team: {
        ...(parsed.director === null ? {} : { director: parsed.director }),
        ...(parsed.worker === null ? {} : { worker: parsed.worker }),
        ...(parsed.reviewer === null ? {} : { reviewer: parsed.reviewer }),
      },
      controller,
      lines: stdinLines,
      piped: process.stdin.isTTY !== true,
      questions: cliShowsQuestions({
        stdinIsTTY: process.stdin.isTTY === true,
        noApproval: parsed.noApproval,
      }),
      projectGate: { approveFirst: parsed.approve, approveVersion: parsed.approveVersion, auto: parsed.autoApproveProject },
    });
    const finalSession = loop.session;
    if (!parsed.incognito) runtime.sessionStore.save(finalSession);
    process.stderr.write(
      `${JSON.stringify(
        {
          sessionId: finalSession.id,
          status: finalSession.status,
          turnCount: finalSession.turnCount,
          stepCount: finalSession.stepCount,
          lastError: finalSession.lastError,
        },
        null,
        2,
      )}\n`,
    );
    // `stalled` means the step budget ran out with nothing produced —
    // that is not success, and a CI job watching this exit code must not
    // read it as one. Only `completed` (and a clean EOF on an idle
    // session) count as 0.
    if (isFailedSessionStatus(finalSession.status) || loop.projectGate === "refused") {
      exitCode = 1;
    } else if (loop.projectGate === "waiting") {
      exitCode = PROJECT_GATE_EXIT;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`fatal: ${msg}\n`);
    exitCode = 1;
  } finally {
    stdinLines?.close();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    // The incognito chat goes before the store closes; one the delete
    // misses is swept at the next start.
    if (incognitoSessionId !== null) runtime.discardIncognitoSession?.(incognitoSessionId);
    await runtime.shutdown();
  }
  return exitCode;
}
