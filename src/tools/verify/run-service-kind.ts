/**
 * `kind: "service"` — start a server in the copy, wait until a port
 * accepts connections or a URL answers 2xx, send the requests, kill the
 * group. A page run with `start` uses the same lifecycle and does its
 * browser work in `whileReady`, before the group is killed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { dirname, join } from "node:path";

import { readOsSandboxSettings } from "../../sandbox/os-sandbox.js";
import { linuxServiceInvocation, probeLinuxService } from "./linux-service-probe.js";

import { resolveInvocation, spawnVerifyProcess, type VerifyProcess } from "./spawn-verify-process.js";
import type { VerifyRequestSpec, VerifyRunArgs } from "./verify-run-args.js";

export interface RequestOutcome {
  readonly method: string;
  readonly url: string;
  readonly status: number | null;
  readonly ok: boolean;
  readonly bodyHead: string;
  readonly ms: number;
  readonly error?: string;
}

export interface ServiceRunOutcome {
  readonly commandLine: string;
  readonly ready: boolean;
  readonly readyMs: number | null;
  readonly readyError?: string;
  readonly requests: readonly RequestOutcome[];
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly durationMs: number;
}

export type FetchLike = (
  url: string,
  init: { method: string; body?: string; headers?: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

const READY_POLL_MS = 250;
const REQUEST_TIMEOUT_MS = 10_000;
const BODY_HEAD_CHARS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1_000, () => done(false));
  });
}

async function urlAnswers(url: string, fetchImpl: FetchLike): Promise<boolean> {
  try {
    const res = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(2_000) });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

/** Poll until ready, the process exits, or the ready budget runs out. */
async function waitForReady(
  proc: VerifyProcess,
  ready: NonNullable<VerifyRunArgs["ready"]>,
  fetchImpl: FetchLike,
  openPort: (port: number) => Promise<boolean>,
): Promise<{ ready: boolean; readyMs: number | null; error?: string }> {
  const started = Date.now();
  let exited = false;
  void proc.exited.then(() => {
    exited = true;
  });
  while (Date.now() - started < ready.timeoutMs) {
    if (exited) {
      return { ready: false, readyMs: null, error: "the process exited before it was ready" };
    }
    const open =
      ready.url !== undefined
        ? await urlAnswers(ready.url, fetchImpl)
        : ready.port !== undefined && (await openPort(ready.port));
    if (open) return { ready: true, readyMs: Date.now() - started };
    await sleep(READY_POLL_MS);
  }
  return {
    ready: false,
    readyMs: null,
    error: `not ready after ${ready.timeoutMs} ms (${ready.url ?? `port ${ready.port}`})`,
  };
}

function baseUrlFor(ready: NonNullable<VerifyRunArgs["ready"]>): string {
  if (ready.url !== undefined) return new URL(ready.url).origin;
  return `http://127.0.0.1:${ready.port}`;
}

async function sendRequest(
  spec: VerifyRequestSpec,
  baseUrl: string,
  fetchImpl: FetchLike,
): Promise<RequestOutcome> {
  const method = (spec.method ?? "GET").toUpperCase();
  const url = spec.url ?? new URL(spec.path ?? "/", `${baseUrl}/`).href;
  const started = Date.now();
  try {
    const res = await fetchImpl(url, {
      method,
      ...(spec.body === undefined ? {} : { body: spec.body, headers: { "content-type": "application/json" } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await res.text();
    const statusOk =
      spec.expectStatus === undefined
        ? res.status >= 200 && res.status < 300
        : res.status === spec.expectStatus;
    const bodyOk = spec.expectBody === undefined || body.includes(spec.expectBody);
    return {
      method,
      url,
      status: res.status,
      ok: statusOk && bodyOk,
      bodyHead: body.slice(0, BODY_HEAD_CHARS),
      ms: Date.now() - started,
      ...(bodyOk ? {} : { error: `body does not contain ${JSON.stringify(spec.expectBody)}` }),
    };
  } catch (err) {
    return {
      method,
      url,
      status: null,
      ok: false,
      bodyHead: "",
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface ServiceContext {
  cwd: string;
  workspaceRoot: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  /** Runs once the server is ready, after the requests; the server stays up until it settles. */
  whileReady?: () => Promise<void>;
}

export async function runServiceKind(args: VerifyRunArgs, ctx: ServiceContext): Promise<ServiceRunOutcome> {
  const privateNetwork = process.platform === "linux" && readOsSandboxSettings().mode === "workspace";
  if (!privateNetwork) return await runServiceProcess(args, ctx);
  if (ctx.whileReady !== undefined) {
    throw new Error("Safe Mode: a host browser cannot reach a service in the private Linux network namespace.");
  }
  // Linux Unix sockets have a short path limit, independent of TMPDIR.
  const relay = await mkdtemp("/tmp/atomic-verify-probe-");
  try {
    return await runServiceProcess(args, ctx, join(relay, "probe.sock"));
  } finally {
    await rm(relay, { recursive: true, force: true });
  }
}

async function runServiceProcess(
  args: VerifyRunArgs,
  ctx: ServiceContext,
  socketPath?: string,
): Promise<ServiceRunOutcome> {
  const started = Date.now();
  let fetchImpl: FetchLike = ctx.fetchImpl ?? ((url, init) => fetch(url, init));
  let openPort = portOpen;
  const start = args.start ?? { cmd: "", args: [] };
  const ready = args.ready ?? { timeoutMs: 0 };
  const proc = spawnVerifyProcess(start.cmd, start.args ?? [], {
    cwd: ctx.cwd,
    workspaceRoot: ctx.workspaceRoot,
    env: args.env,
    network: args.network,
    timeoutMs: args.timeoutMs,
    signal: ctx.signal,
    ...(socketPath === undefined ? {} : {
      relayDir: dirname(socketPath),
      invocation: linuxServiceInvocation(resolveInvocation(start.cmd, start.args ?? []), socketPath),
    }),
  });
  const requests: RequestOutcome[] = [];
  let readiness: Awaited<ReturnType<typeof waitForReady>>;
  try {
    if (socketPath !== undefined) {
      const inNamespace = (signal: AbortSignal) => ctx.signal === undefined ? signal : AbortSignal.any([ctx.signal, signal]);
      fetchImpl = async (url, { signal, ...request }) => {
        const result = await probeLinuxService(socketPath, { url, ...request }, inNamespace(signal));
        return { status: result.status, text: async () => result.body };
      };
      openPort = async port => {
        try {
          await probeLinuxService(socketPath, { port }, inNamespace(AbortSignal.timeout(1000)));
          return true;
        } catch {
          return false;
        }
      };
    }
    readiness = await waitForReady(proc, ready, fetchImpl, openPort);
    if (readiness.ready) {
      const baseUrl = baseUrlFor(ready);
      for (const spec of args.requests ?? []) {
        if (ctx.signal?.aborted) break;
        requests.push(await sendRequest(spec, baseUrl, fetchImpl));
      }
      if (ctx.whileReady !== undefined && !ctx.signal?.aborted) await ctx.whileReady();
    }
  } finally {
    proc.killGroup();
  }
  const exit = await proc.exited;
  return {
    commandLine: proc.commandLine,
    ready: readiness.ready,
    readyMs: readiness.readyMs,
    ...(readiness.error === undefined ? {} : { readyError: readiness.error }),
    requests,
    exitCode: exit.exitCode,
    timedOut: exit.timedOut,
    stdout: proc.stdout.all(),
    stderr: proc.stderr.all(),
    stdoutTail: proc.stdout.tail(),
    stderrTail: proc.stderr.tail(),
    durationMs: Date.now() - started,
  };
}
