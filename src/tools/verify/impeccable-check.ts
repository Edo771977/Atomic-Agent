import { constants } from "node:fs";
import { access, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, extname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { buildDirectInvocation, buildSubshellInvocation } from "../../sandbox/shell-invocation.js";
import type { ArtifactOutcome } from "./artifact-process.js";
import { readArtifactSnapshot } from "./artifact-snapshot.js";
import { spawnVerifyProcess } from "./spawn-verify-process.js";
import type { VerifyRunArgs } from "./verify-run-args.js";

// Accessibility and visibly broken assets block delivery. Other detector rules
// are advisory here, even when Impeccable itself returns exit code 2.
const SEVERE_RULES = new Set(["low-contrast", "broken-image-source"]);
const SOURCE_EXTENSIONS = new Set([".html", ".htm", ".css", ".scss", ".sass", ".less", ".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".astro"]);
const MAX_REPORT_CHARS = 1024 * 1024;

interface ImpeccableOutcome extends ArtifactOutcome {
  version?: string;
  findings?: readonly string[];
  suppressions?: readonly string[];
}

async function findImpeccable(project: string, signal?: AbortSignal): Promise<string | undefined> {
  const path = process.env.PATH ?? "";
  const names = process.platform === "win32" ? ["impeccable.exe", "impeccable.cmd"] : ["impeccable"];
  const dirs = [resolve(project, "node_modules", ".bin"), ...path.split(delimiter).filter(dir => isAbsolute(dir))];
  for (const dir of dirs) {
    for (const name of names) {
      signal?.throwIfAborted();
      const candidate = join(dir, name);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Search the next installed location.
      }
    }
  }
  return undefined;
}

function parseReport(text: string, workspace: string, snapshot: string, source: string) {
  const report = JSON.parse(text);
  const rows: unknown[] = Array.isArray(report) ? report : report?.findings;
  if (!Array.isArray(rows)) throw new Error("impeccable returned invalid findings");
  const findings: string[] = [];
  let chars = 0;
  let severe = false;
  for (const row of rows) {
    if (row === null || typeof row !== "object" || !("antipattern" in row) || !("file" in row) ||
        typeof row.antipattern !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(row.antipattern) ||
        typeof row.file !== "string" || relative(resolve(workspace, row.file), resolve(workspace, snapshot)) !== "") {
      throw new Error("impeccable returned a finding without a valid rule or checked file");
    }
    const blocking = SEVERE_RULES.has(row.antipattern);
    severe ||= blocking;
    const detail = `${blocking ? "severe" : "warning"}: ${row.antipattern} — ${source}`;
    chars += detail.length + 1;
    if (chars > MAX_REPORT_CHARS) throw new Error("impeccable findings report exceeds the output limit");
    findings.push(detail);
  }
  const count: unknown = Array.isArray(report) ? undefined : report.filesScanned;
  // The findings-only format proves coverage only when a finding names our snapshot.
  return { findings, severe, scanned: count === undefined ? findings.length > 0 : count === 1 };
}

function suppressionLines(source: string, bytes: Buffer): string[] {
  const findings: string[] = [];
  let chars = 0;
  let line = 1;
  for (const match of bytes.toString("utf8").matchAll(/\r\n|[\r\n]|\bimpeccable-disable(?:-[a-z]+)*/g)) {
    if (match[0][0] === "\r" || match[0][0] === "\n") {
      line += 1;
    } else {
      const detail = `${source}:${line}: ${match[0]}`;
      chars += detail.length + 1;
      if (chars > MAX_REPORT_CHARS) throw new Error("impeccable suppression report exceeds the output limit");
      findings.push(detail);
    }
  }
  return findings;
}

export async function runImpeccableCheck(
  args: VerifyRunArgs, root: string, cwd: string, project: string, signal?: AbortSignal,
): Promise<ImpeccableOutcome> {
  const timeoutMs = Math.max(1, Math.min(15_000, Math.floor(args.timeoutMs)));
  const deadline = performance.now() + timeoutMs;
  let workspace: string | undefined;
  let version: string | undefined;
  let suppressions: string[] = [];
  const complete = (status: ArtifactOutcome["status"], reason: string, findings: string[] = [], timedOut = false): ImpeccableOutcome => {
    const evidence = [...findings, ...suppressions].join("\n");
    const head = [reason, ...(version === undefined ? [] : [`impeccable version: ${version}`])].join("\n");
    if (evidence.length > MAX_REPORT_CHARS) {
      return { status: "uncheckable", detail: `${head}\nimpeccable report exceeds the output limit`, version, suppressions };
    }
    return { status, detail: evidence ? `${head}\n${evidence}` : head, version, findings, suppressions, ...(timedOut ? { timedOut } : {}) };
  };
  const timeout = () => complete("uncheckable", `impeccable timed out after ${timeoutMs} ms`, [], true);

  try {
    const executable = await findImpeccable(project, signal);
    if (executable === undefined) return complete("uncheckable", "impeccable non installato");

    const source = relative(root, resolve(cwd, args.path!));
    const extension = extname(source).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(extension)) return complete("uncheckable", "expected a supported UI source file");
    const bytes = await readArtifactSnapshot(root, relative(root, cwd), args.path!);
    suppressions = suppressionLines(source, bytes);
    const scratch = await mkdtemp(join(await realpath(tmpdir()), "verify-impeccable-"));
    workspace = scratch;
    const snapshot = `./input${extension}`;
    await writeFile(join(scratch, snapshot), bytes, { mode: 0o600 });

    const run = async (argv: string[]) => {
      signal?.throwIfAborted();
      const remaining = deadline - performance.now();
      if (remaining <= 0) return undefined;
      const batch = process.platform === "win32" && executable.endsWith(".cmd");
      const invocation = batch
        ? buildSubshellInvocation(`"%ATOMIC_IMPECCABLE_EXECUTABLE%" ${argv.join(" ")}`)
        : buildDirectInvocation(executable, argv);
      if (batch) invocation.args.unshift("/v:off");
      const processRun = spawnVerifyProcess(executable, argv, {
        cwd: scratch, signal, timeoutMs: remaining, network: false,
        invocation: { ...invocation, commandLine: ["impeccable", ...argv].join(" ") },
        env: {
          ...(batch ? { ATOMIC_IMPECCABLE_EXECUTABLE: executable } : {}),
          // The upstream npm launcher can fall back to fetching a missing
          // engine. Give that fallback an unsupported URL scheme.
          IMPECCABLE_DOWNLOAD_BASE: "atomic-offline:",
          IMPECCABLE_BIN: "",
          npm_config_offline: "true",
        },
      });
      const exit = await processRun.exited;
      signal?.throwIfAborted();
      return { ...exit, stdout: processRun.stdout, outputTruncated: processRun.stdout.truncated || processRun.stderr.truncated };
    };

    const versionRun = await run(["--version"]);
    if (versionRun === undefined || versionRun.timedOut) return timeout();
    const reportedVersion = versionRun.stdout.all().trim();
    if (versionRun.exitCode !== 0 || !reportedVersion || reportedVersion.length > 128 || /[\r\n]/.test(reportedVersion) || versionRun.outputTruncated) {
      return complete("uncheckable", "could not determine the installed impeccable version");
    }
    version = reportedVersion;

    const scan = await run(["detect", "--json", "--no-config", snapshot]);
    if (scan === undefined || scan.timedOut) return timeout();
    if (scan.exitCode === 127) return complete("uncheckable", "impeccable non installato");
    if (scan.exitCode !== 0 && scan.exitCode !== 2 && scan.exitCode !== 1) {
      return complete("uncheckable", "impeccable could not run the detector");
    }
    if (scan.outputTruncated) return complete("uncheckable", "impeccable exceeded the output limit");
    const report = parseReport(scan.stdout.all(), scratch, snapshot, source);
    if (scan.exitCode === 1) return complete("uncheckable", "impeccable could not complete the scan (exit 1)", report.findings);
    if (!report.scanned) return complete("uncheckable", "impeccable JSON does not confirm a file was scanned", report.findings);
    if (scan.exitCode === 0 && report.severe) return complete("uncheckable", "impeccable reported a severe rule with exit 0", report.findings);
    const fail = scan.exitCode === 2 && report.severe;
    return complete(fail ? "fail" : "pass", fail ? "impeccable found severe rules" : "impeccable scan completed", report.findings);
  } catch (error) {
    if (signal?.aborted) return complete("uncheckable", "verification cancelled");
    return complete("uncheckable", error instanceof Error ? error.message : "impeccable check failed");
  } finally {
    if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
  }
}
