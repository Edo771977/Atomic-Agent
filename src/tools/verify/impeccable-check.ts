import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { buildDirectInvocation, buildSubshellInvocation } from "../../sandbox/shell-invocation.js";
import type { ArtifactOutcome } from "./artifact-process.js";
import { readArtifactSnapshot } from "./artifact-snapshot.js";
import { spawnVerifyProcess } from "./spawn-verify-process.js";
import { guardVerifyCommand } from "./verify-run-guard.js";
import type { ShellGuardPolicy } from "../os/shell-command-guard/index.js";
import type { ProjectUiException } from "../../session/project-ui-exceptions.js";
import type { VerifyRunArgs } from "./verify-run-args.js";

// Accessibility and visibly broken assets block delivery. Other detector rules
// are advisory here, even when Impeccable itself returns exit code 2.
export const SEVERE_RULES: ReadonlySet<string> = new Set(["low-contrast", "broken-image"]);
const SOURCE_EXTENSIONS = new Set([".html", ".htm", ".jsx", ".tsx", ".vue", ".svelte", ".astro"]);
const MAX_REPORT_CHARS = 1024 * 1024;

interface ImpeccableOutcome extends ArtifactOutcome {
  version?: string;
  findings?: readonly string[];
  suppressions?: readonly string[];
  usedExceptions?: readonly string[];
}

export function impeccableArgs(file: string): string[] {
  return ["detect", "--json", "--no-config", file];
}

export function isImpeccableMarkup(path: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(path).toLowerCase());
}

export const APPROVED_IMPECCABLE = Symbol("approved impeccable executable");

export interface ApprovedImpeccable {
  readonly candidate: string;
  readonly file: string;
  readonly identity: string;
  readonly path?: string;
  readonly serviceUrl?: string;
  readonly exceptionFile?: string;
  readonly exceptions?: readonly ProjectUiException[];
}

async function fileIdentity(file: string): Promise<string> {
  const entry = await stat(file, { bigint: true });
  if (!entry.isFile()) throw new Error("impeccable executable is not a regular file");
  return [entry.dev, entry.ino, entry.mode, entry.size, entry.mtimeNs, entry.ctimeNs].join(":");
}

export async function resolveImpeccable(project: string, cwd: string, signal?: AbortSignal): Promise<ApprovedImpeccable | undefined> {
  const path = process.env.PATH ?? "";
  const names = process.platform === "win32" ? ["impeccable.exe", "impeccable.cmd"] : ["impeccable"];
  const dirs = new Set([resolve(cwd, "node_modules", ".bin"), resolve(project, "node_modules", ".bin"), ...path.split(delimiter).filter(dir => isAbsolute(dir))]);
  for (const dir of dirs) {
    for (const name of names) {
      signal?.throwIfAborted();
      const candidate = join(dir, name);
      try {
        const file = await realpath(candidate);
        await access(file, constants.X_OK);
        return { candidate, file, identity: await fileIdentity(file) };
      } catch {
        // Search the next installed location.
      }
    }
  }
  return undefined;
}

async function assertImpeccableIdentity(approved: ApprovedImpeccable): Promise<void> {
  try {
    if (await realpath(approved.candidate) === approved.file && await fileIdentity(approved.file) === approved.identity) return;
  } catch {
    // Missing or unreadable after approval is also a change.
  }
  throw new Error("impeccable executable changed after approval");
}

function parseReport(text: string, workspace: string, snapshot: string, source: string, url: string | undefined, exceptions: readonly ProjectUiException[], exceptionFile?: string) {
  const rows: unknown = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error("impeccable returned invalid findings");
  const findings: string[] = [];
  let chars = 0;
  let severe = false;
  let primary = false;
  const used = new Map<ProjectUiException, string>();
  for (const row of rows) {
    if (row === null || typeof row !== "object" || !("antipattern" in row) || !("file" in row) ||
        typeof row.antipattern !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(row.antipattern) ||
        typeof row.file !== "string" || (url === undefined ? relative(resolve(workspace, row.file), snapshot) !== "" : new URL(row.file).href !== new URL(url).href)) {
      throw new Error("impeccable returned a finding without a valid rule or checked file");
    }
    const advisory = ("advisory" in row && row.advisory === true) || ("severity" in row && row.severity === "advisory");
    primary ||= !advisory;
    const rule = row.antipattern;
    const exception = exceptions.find(entry => entry.rule === rule && exceptionFile !== undefined && entry.file === exceptionFile)
      ?? exceptions.find(entry => entry.rule === rule && entry.file === undefined);
    if (exception !== undefined && !used.has(exception)) {
      const scope = exception.file === undefined ? "" : `:${exception.file}`;
      used.set(exception, `${rule}${scope} — approved by the operator: ${exception.reason}`);
    }
    const blocking = exception === undefined && !advisory && (SEVERE_RULES.has(row.antipattern) || ("severity" in row && row.severity === "error"));
    severe ||= blocking;
    const detail = `${blocking ? "severe" : "warning"}: ${row.antipattern} — ${source}${exception === undefined ? "" : ` (approved by the operator: ${exception.reason})`}`;
    chars += detail.length + 1;
    if (chars > MAX_REPORT_CHARS) throw new Error("impeccable findings report exceeds the output limit");
    findings.push(detail);
  }
  return { findings, severe, primary, usedExceptions: [...used.values()] };
}

function suppressionLines(source: string, bytes: Buffer) {
  const findings: string[] = [];
  let potentiallyActive = false;
  let chars = 0;
  let line = 1;
  const markers = /\r\n|[\r\n]|\bimpeccable-(?:disable(?:-[a-z]+)*|ignore-(?:start|end))\b|\bdata-impeccable-ignore\b(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi;
  for (const match of bytes.toString("utf8").matchAll(markers)) {
    const marker = match[0];
    if (marker[0] !== "\r" && marker[0] !== "\n") {
      potentiallyActive ||= !marker.toLowerCase().startsWith("impeccable-disable");
      const detail = `${source}:${line}: ${marker.replace(/\s+/g, " ")}`;
      chars += detail.length + 1;
      if (chars > MAX_REPORT_CHARS) throw new Error("impeccable suppression report exceeds the output limit");
      findings.push(detail);
    }
    line += marker.match(/\r\n|[\r\n]/g)?.length ?? 0;
  }
  return { findings, potentiallyActive };
}

export async function runImpeccableCheck(
  args: VerifyRunArgs, root: string, cwd: string, approved: ApprovedImpeccable | undefined, policy?: ShellGuardPolicy, signal?: AbortSignal,
): Promise<ImpeccableOutcome> {
  const timeoutMs = Math.max(1, Math.min(15_000, Math.floor(args.timeoutMs)));
  const deadline = performance.now() + timeoutMs;
  let version: string | undefined;
  let suppressions: string[] = [];
  let usedExceptions: string[] | undefined;
  const complete = (status: ArtifactOutcome["status"], reason: string, findings: string[] = [], timedOut = false): ImpeccableOutcome => {
    const evidence = [...findings, ...suppressions].join("\n");
    const head = [reason, ...(version === undefined ? [] : [`impeccable version: ${version}`])].join("\n");
    if (evidence.length > MAX_REPORT_CHARS) {
      return { status: "uncheckable", detail: `${head}\nimpeccable report exceeds the output limit`, version, suppressions };
    }
    return { status, detail: evidence ? `${head}\n${evidence}` : head, version, findings, suppressions, usedExceptions, ...(timedOut ? { timedOut } : {}) };
  };
  const timeout = () => complete("uncheckable", `impeccable timed out after ${timeoutMs} ms`, [], true);

  try {
    const source = args.url ?? relative(root, resolve(cwd, args.path!));
    if (args.url === undefined && !isImpeccableMarkup(source)) {
      return complete("uncheckable", "impeccable scans markup: specify the file that uses this CSS or script");
    }
    if (approved === undefined) return complete("uncheckable", "impeccable is not installed");
    const executable = approved.file;
    const markers = args.url === undefined
      ? suppressionLines(source, await readArtifactSnapshot(root, relative(root, cwd), args.path!))
      : { findings: [], potentiallyActive: false };
    suppressions = markers.findings;
    const scanCwd = await realpath(cwd);
    const scanTarget = args.url ?? await realpath(resolve(cwd, args.path!));

    const run = async (argv: string[]) => {
      await assertImpeccableIdentity(approved);
      const verdict = guardVerifyCommand(executable, argv, scanCwd, policy, false);
      if (verdict.action === "block") throw new Error(`impeccable blocked by shell guard: ${verdict.rule} - ${verdict.reason}`);
      signal?.throwIfAborted();
      const remaining = deadline - performance.now();
      if (remaining <= 0) return undefined;
      const batch = process.platform === "win32" && executable.endsWith(".cmd");
      if (batch && /[%!^&|<>()\r\n]/.test(scanTarget)) {
        throw new Error("impeccable cannot pass this target safely to a Windows command shim");
      }
      const invocation = batch
        ? buildSubshellInvocation(`"%ATOMIC_IMPECCABLE_EXECUTABLE%" ${argv[0] === "detect" ? 'detect --json --no-config "%ATOMIC_IMPECCABLE_TARGET%"' : "--version"}`)
        : buildDirectInvocation(executable, argv);
      if (batch) invocation.args.unshift("/v:off");
      const processRun = spawnVerifyProcess(executable, argv, {
        cwd: scanCwd, signal, timeoutMs: remaining, network: false,
        invocation: { ...invocation, commandLine: ["impeccable", ...argv].join(" ") },
        env: {
          ...(batch ? { ATOMIC_IMPECCABLE_EXECUTABLE: executable, ATOMIC_IMPECCABLE_TARGET: scanTarget } : {}),
          // The upstream npm launcher can fall back to fetching a missing
          // engine. Give that fallback an unsupported URL scheme.
          IMPECCABLE_DOWNLOAD_BASE: "atomic-offline:",
          IMPECCABLE_BIN: "",
          ...(approved.path === undefined ? {} : { PATH: approved.path }),
          ...(args.url === undefined ? {} : { NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1" }),
          DO_NOT_TRACK: "1",
          ...(args.url === undefined ? { IMPECCABLE_SAMPLE_CACHE: join(root, ".impeccable-sample-cache") } : {}),
          npm_config_offline: "true",
        },
      });
      const exit = await processRun.exited;
      signal?.throwIfAborted();
      return { ...exit, stdout: processRun.stdout, stderr: processRun.stderr, outputTruncated: processRun.stdout.truncated || processRun.stderr.truncated };
    };

    const versionRun = await run(["--version"]);
    if (versionRun === undefined || versionRun.timedOut) return timeout();
    if ([127, 9009].includes(versionRun.exitCode ?? -1)) return complete("uncheckable", "impeccable is not installed");
    const reportedVersion = versionRun.stdout.all().trim();
    if (versionRun.exitCode !== 0 || !reportedVersion || reportedVersion.length > 128 || /[\r\n]/.test(reportedVersion) || versionRun.outputTruncated) {
      return complete("uncheckable", "could not determine the installed impeccable version");
    }
    version = reportedVersion;

    const scan = await run(impeccableArgs(scanTarget));
    if (scan === undefined || scan.timedOut) return timeout();
    if (scan.exitCode === 127 || scan.exitCode === 9009) return complete("uncheckable", "impeccable is not installed");
    if (scan.exitCode === 1) {
      const missingBrowser = args.url !== undefined && /(?:no|not found|could not find|cannot find|not installed)[^\r\n]*(?:chrome|chromium|edge|browser)|(?:chrome|chromium|edge|browser)[^\r\n]*(?:not found|not installed)/i.test(scan.stderr.all());
      return complete("uncheckable", missingBrowser
        ? "impeccable needs an installed browser (Chrome or Edge)"
        : "impeccable could not complete the scan (exit 1)");
    }
    if (scan.exitCode !== 0 && scan.exitCode !== 2) return complete("uncheckable", "impeccable could not run the detector");
    if (scan.outputTruncated) return complete("uncheckable", "impeccable exceeded the output limit");
    const report = parseReport(scan.stdout.all(), scanCwd, scanTarget, source, args.url, approved.exceptions ?? [], approved.exceptionFile);
    if (scan.exitCode === 2 && !report.primary) return complete("uncheckable", "impeccable returned exit 2 with no primary findings", report.findings);
    if (scan.exitCode === 0 && report.primary) return complete("uncheckable", "impeccable returned primary findings with exit 0", report.findings);
    if (report.usedExceptions.length > 0) usedExceptions = report.usedExceptions;
    const fail = scan.exitCode === 2 && report.severe;
    if (!fail && args.url !== undefined) {
      return complete("uncheckable", "a rendered scan cannot rule out suppressions inserted by the page; also check the source file (path)", report.findings);
    }
    if (!fail && markers.potentiallyActive) {
      return complete("uncheckable", "impeccable suppression markers could hide findings", report.findings);
    }
    return complete(fail ? "fail" : "pass", fail ? "impeccable found severe rules" : "impeccable scan completed", report.findings);
  } catch (error) {
    if (signal?.aborted) return complete("uncheckable", "verification cancelled");
    return complete("uncheckable", error instanceof Error ? error.message : "impeccable check failed");
  }
}
