import { resolveBootApprovalLevel } from "../approval/approval-level.js";
import { getConfig } from "../config/index.js";
import { AGENT_TOOL_CHILD_ENV } from "../sandbox/command-env.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import { createStderrSink } from "../tracing/structured-logger.js";
import { PrometheusRegistry } from "../tracing/prometheus-registry.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";

import { HELP, lanUrls, parseArgs } from "./serve-args.js";
import { resolveServeApiKey, serveApiKeyNotice } from "./serve-api-key.js";
import {
  MEMORY_GUARD_EXIT_CODE,
  memoryGuardDisabled,
  startServeMemoryGuard,
  type ServeMemoryGuard,
} from "./serve-memory-guard.js";
import { watchForOrphaning } from "./serve-orphan-guard.js";
import {
  startWebhookTunnel,
  tunnelPreflight,
  type TunnelPreflight,
  type WebhookTunnel,
} from "./serve-webhook-tunnel.js";
import {
  formatReapOutcomes,
  registerServe,
  reapOrphanedServes,
} from "./serve-reaper.js";

import {
  ApprovalBus,
  ProjectGateBus,
  buildRouteTable,
  CompletionRegistry,
  createHttpServer,
} from "../http/index.js";
import type { HttpServerHandle } from "../http/index.js";
import { isNetworkListenHost } from "../http/serve-egress.js";

/**
 * Entry point for `atomic-agent serve`. Boots the shared agent runtime
 * once, wires it to an HTTP-facing approval bus, starts the server,
 * and hands control to the host process until SIGINT/SIGTERM. Per-turn
 * concurrency is owned by `runtime.turnController`, so HTTP requests on
 * different sessions run in parallel while same-session requests
 * serialise FIFO automatically.
 */
export async function serveCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  // Issue #74: the key is in `parsed` now. Out of the environment it goes,
  // so no tool, shell or child process serve starts inherits it (the
  // desktop passes its per-launch key here instead of on the command line).
  delete process.env.ATOMIC_AGENT_API_KEY;
  if ("help" in parsed) {
    process.stdout.write(HELP);
    return 0;
  }
  if ("error" in parsed) {
    process.stderr.write(`serve: ${parsed.error}\n`);
    process.stderr.write(HELP);
    return 1;
  }

  if (process.env[AGENT_TOOL_CHILD_ENV] !== undefined) {
    process.stderr.write("serve: run this command from the operator's terminal, outside an agent tool process.\n");
    return 1;
  }

  const stateDir = getConfig().paths.stateDir;
  if (parsed.reapOnly) {
    process.stdout.write(formatReapOutcomes(await reapOrphanedServes({ stateDir })));
    return 0;
  }

  // Always a key, on loopback too: the operator's, else the persisted one
  // made on the first run. No key, no server.
  const apiKey = resolveServeApiKey(parsed.apiKey, stateDir);
  if ("error" in apiKey) {
    process.stderr.write(`serve: ${apiKey.error}\n`);
    return 1;
  }
  if (parsed.printApiKey) {
    process.stdout.write(`${apiKey.key}\n`);
    return 0;
  }

  // ATO-625: refuse the tunnel before anything boots, so a missing
  // cloudflared or a webhook set with no secret never opens a public address.
  let tunnelCheck: Extract<TunnelPreflight, { ok: true }> | null = null;
  if (parsed.tunnel) {
    const config = getConfig();
    const check = tunnelPreflight({
      webhooks: config.webhooks,
      tasksEnabled: config.tasks.enabled,
    });
    if (!check.ok) {
      process.stderr.write(`serve: ${check.error}\n`);
      return 1;
    }
    tunnelCheck = check;
  }

  const approvalBus = new ApprovalBus();
  const projectGateBus = new ProjectGateBus();
  const completionRegistry = new CompletionRegistry();
  // ATO-646: what `GET /metrics` reports, folded in memory from the
  // runtime's metric samples.
  const metricsRegistry = new PrometheusRegistry();

  let runtime: AgentRuntime | null = null;
  // ATO-1419: the memory guard ended this serve; its task runs are left as crashed.
  let crashedShutdown = false;
  let handle: HttpServerHandle | null = null;
  let releaseRecord: (() => void) | null = null;
  let orphanWatch: OrphanWatch | null = null;
  let memoryGuard: ServeMemoryGuard | null = null;
  let tunnel: WebhookTunnel | null = null;
  try {
    runtime = await createAgentRuntime({
      workingDir: parsed.workingDir,
      // Same boot contract as `run` and `tui`: the persisted
      // `agent.approvalLevel` is the baseline and `--no-approval` can
      // only force level 5 (approve everything) for this process, never
      // a stricter level. Keeping serve on this rule makes the Privacy
      // tab's "persists to config.json and applies to future runs too"
      // promise hold for every interactive entry point.
      approvalLevel: resolveBootApprovalLevel(
        parsed.noApproval,
        getConfig().agent.approvalLevel,
      ),
      traceDefault: true,
      // A host that died (the desktop app, Force Quit) leaves stderr a
      // dead pipe. The next log line used to exit the process there and
      // then, skipping the `finally` below — the port, the session
      // store's turn ends, the serve record. Muted, serve goes on until
      // the orphan watch ends it through that teardown.
      brokenPipe: "mute",
      handlers: {
        // The structured log goes to stderr, which a host running serve
        // relays into its own log (the desktop app's agent.log and its
        // Diagnostics pane); `config.log.level` still decides what is
        // written. Serve once passed `stderrSink` here, the factory and
        // not the sink it builds, and nothing was ever written: the
        // factory's parameter makes that a compile error now, and
        // `serve-command.test.ts` reads what is passed here.
        logSinks: [createStderrSink()],
        // Issue #39: fusion project gates reach GET /api/events.
        onAgentEvent: (event) => {
          if (event.type === "project_gate") projectGateBus.publish(event);
        },
        metricSinks: [metricsRegistry.sink],
        onApprovalRequest: (request) => {
          // ATO-1111: drop mirrored prompts whose turn was aborted, so a
          // window that never reconnects /api/events does not keep them.
          const live = runtime;
          if (live) approvalBus.prune((r) => live.approvals.isPending(r.approvalId));
          approvalBus.publish(request);
        },
      },
    });
    handle = await createHttpServer({
      runtime,
      host: parsed.host,
      port: parsed.port,
      apiKey: apiKey.key,
      routes: buildRouteTable({ metricsRegistry }),
      approvalBus,
      projectGateBus,
      completionRegistry,
    });
    const baseUrl = `http://${handle.host}:${handle.port}`;
    process.stderr.write(
      `[atomic-agent] serve listening on ${baseUrl} (auth=bearer, cwd=${parsed.workingDir})\n`,
    );
    process.stderr.write(serveApiKeyNotice(apiKey, baseUrl, process.stderr.isTTY === true));
    // Issue #33: on a network address, constrained folders without
    // "serve" in allowedEgress are refused over HTTP (serve-egress.ts).
    const constraintNote = serveConstraintNote(handle.host, getConfig().projects.constraints);
    if (constraintNote) process.stderr.write(constraintNote);
    // ATO-1126: on every interface, say where another device reaches it (the desktop's remote agent, a phone).
    for (const url of lanUrls(parsed.host, handle.port)) {
      process.stderr.write(`[atomic-agent] serve reachable at ${url}\n`);
    }
    if (parsed.tunnel && tunnelCheck) {
      tunnel = await startWebhookTunnel({
        runtime,
        request: parsed.tunnel,
        preflight: tunnelCheck,
        apiKey: apiKey.key,
        approvalBus,
        completionRegistry,
        write: (line) => process.stderr.write(line),
      });
      process.stderr.write(
        `[atomic-agent] tunnel: starting cloudflared (${parsed.tunnel.mode}) for webhooks only, gateway on 127.0.0.1:${tunnel.gatewayPort}\n`,
      );
      // Not awaited: the public address can take a few seconds, and the
      // local API serves meanwhile. The outcome is logged and shown on
      // GET /api/webhooks.
      void tunnel.ready;
    }

    releaseRecord = registerServe(stateDir, {
      pid: process.pid,
      bootPpid: process.ppid,
      // A server that is told to outlive its parent, or that had none to
      // begin with, is a daemon on purpose and must never be swept.
      daemon: parsed.noParentExit || process.ppid <= 1,
      host: handle.host,
      port: handle.port,
      cwd: parsed.workingDir,
      startedAt: new Date().toISOString(),
    });
    // Each new server tidies up after the generation before it. Failures
    // here are never fatal — the sweep is housekeeping, not startup — and
    // it is deliberately not awaited, because a stray that needs the full
    // SIGTERM grace would otherwise hold up serving traffic.
    void reapOrphanedServes({ stateDir }).catch(() => []);

    const liveRuntime = runtime;
    orphanWatch = parsed.noParentExit
      ? null
      : waitForOrphaning(
          () => liveRuntime.turnController.busySessionIds().length > 0,
          parsed.parentPid ?? undefined,
        );

    // ATO-1111: end through the teardown below, with its own exit code,
    // before the OS refuses memory (Windows 0xC000009A) and kills it mid-write.
    memoryGuard = memoryGuardDisabled()
      ? null
      : startServeMemoryGuard({
          isBusy: () => liveRuntime.turnController.busySessionIds().length > 0,
          // A daemon has no supervisor to start it again: it only reports the line.
          exitAllowed: !(parsed.noParentExit || process.ppid <= 1),
        });
    let exitCode = 0;
    await Promise.race([
      waitForShutdownSignal().then((signal) => {
        process.stderr.write(`[atomic-agent] ${signal} received, closing\n`);
      }),
      orphanWatch?.orphaned ?? new Promise<void>(() => {}),
      memoryGuard?.exhausted.then(() => {
        exitCode = MEMORY_GUARD_EXIT_CODE;
        crashedShutdown = true;
      }) ?? new Promise<void>(() => {}),
    ]);
    return exitCode;
  } catch (err) {
    const message =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`serve failed: ${message}\n`);
    return 1;
  } finally {
    memoryGuard?.stop();
    orphanWatch?.stop();
    // The public address goes first, before the API it fronts.
    if (tunnel) await tunnel.stop().catch(() => {});
    if (handle) await handle.close();
    if (runtime) await runtime.shutdown(crashedShutdown ? { crashed: true } : undefined);
    // Released last, and only once the port and the databases are
    // actually let go. A teardown that wedges must stay on record:
    // a process still holding its port with no record is precisely the
    // invisible stray this module exists to prevent.
    releaseRecord?.();
  }
}

interface OrphanWatch {
  /** Resolves once the parent is gone and no turn is in flight. */
  readonly orphaned: Promise<void>;
  readonly stop: () => void;
}

/**
 * Bridge the orphan watch into the same shape as `waitForShutdownSignal`,
 * so the two ways a serve can end race against each other and share one
 * teardown path.
 */
function waitForOrphaning(isBusy: () => boolean, parentPid?: number): OrphanWatch {
  let stop = (): void => {};
  const orphaned = new Promise<void>((resolveOrphaned) => {
    stop = watchForOrphaning({
      parentPid,
      isBusy,
      onOrphanedWhileBusy: () =>
        process.stderr.write(
          "[atomic-agent] parent exited; finishing the turn in flight before closing\n",
        ),
      onOrphaned: () => {
        process.stderr.write(
          "[atomic-agent] parent exited and no turn is running, closing\n",
        );
        resolveOrphaned();
      },
    });
  });
  return { orphaned, stop: () => stop() };
}

/**
 * Resolve the returned promise when SIGINT or SIGTERM is received.
 * We do not install the listeners permanently — they come down with
 * the process. This keeps the command well-behaved when invoked from
 * a test harness that wants to `cancel()` via a different channel.
 */
function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolvePromise) => {
    const onSignal = (signal: NodeJS.Signals): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolvePromise(signal);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

/**
 * The startup line `serve` prints when it listens on a network address
 * while folders are constrained (issue #33): those without "serve" in
 * `allowedEgress` are refused over this server. `null` otherwise.
 */
export function serveConstraintNote(
  host: string,
  constraints: Record<string, { allowedEgress?: string[] }>,
): string | null {
  if (!isNetworkListenHost(host)) return null;
  const refused = Object.entries(constraints)
    .filter(([, entry]) => !(entry.allowedEgress ?? []).includes("serve"))
    .map(([folder]) => folder);
  if (refused.length === 0) return null;
  return `[atomic-agent] serve: this address reaches other machines; sessions in ${refused.join(", ")} (and sessions that read files there) are refused over HTTP. Add "serve" to that folder's projects.constraints allowedEgress to allow it.\n`;
}
