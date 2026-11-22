import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ArtifactKind, VerifyRunArgs } from "./verify-run-args.js";

export const ARTIFACT_NODE_OPTIONS = "--permission --allow-fs-read=* --max-old-space-size=256";

export interface ArtifactOutcome {
  status: "pass" | "fail" | "uncheckable";
  detail: string;
  timedOut?: boolean;
}
export interface ArtifactJob {
  root: string;
  cwd: string;
  kind: ArtifactKind;
  path: string;
  spec: Record<string, unknown>;
}

// In a source checkout, Node strips types natively but relative imports in our
// TS files name their compiled .js outputs. The packaged application needs no hook.
const sourceImports = `
  import { registerHooks } from 'node:module';
  registerHooks({ resolve(name, ctx, next) {
    try { return next(name, ctx); } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !ctx.parentURL?.endsWith('.ts') ||
          !name.startsWith('.') || !name.endsWith('.js')) throw error;
      return next(name.slice(0, -3) + '.ts', ctx);
    }
  }});
`;

function childCommand(): string[] {
  if (isSea()) return ["--internal-verify-artifact"];
  const modulePath = fileURLToPath(import.meta.url);
  const source = modulePath.endsWith(".ts");
  const entry = pathToFileURL(join(dirname(modulePath), source ? "artifact-reader.ts" : "artifact-reader.js")).href;
  return ["--input-type=module", "-e",
    (source ? sourceImports : "") + "const { serveArtifactCheck } = await import(process.argv[1]); process.exitCode = await serveArtifactCheck();",
    entry];
}

/** Parent-owned timeout also interrupts synchronous library work and native I/O. */
export async function runArtifactCheck(kind: ArtifactKind, args: VerifyRunArgs, root: string, cwd: string, signal?: AbortSignal): Promise<ArtifactOutcome> {
  signal?.throwIfAborted();
  const timeoutMs = Math.max(1, Math.min(15_000, Math.floor(args.timeoutMs)));
  const child = spawn(process.execPath, childCommand(), {
    cwd: tmpdir(), windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    // Load the installed parsers and read the authorized file. The child has
    // no network, subprocess or filesystem write permission, nor runtime credentials.
    env: { SystemRoot: process.env.SystemRoot, NODE_OPTIONS: ARTIFACT_NODE_OPTIONS },
  });
  return new Promise<ArtifactOutcome>((done) => {
    let settled = false;
    const finish = (result: ArtifactOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      child.kill("SIGKILL");
      done(result);
    };
    const cancel = () => finish({ status: "uncheckable", detail: "verification cancelled" });
    const timer = setTimeout(() => finish({ status: "uncheckable", detail: `parser timed out after ${timeoutMs} ms`, timedOut: true }), timeoutMs);
    child.once("error", () => finish({ status: "uncheckable", detail: "could not launch the offline artifact reader" }));
    child.once("exit", () => finish({ status: "uncheckable", detail: "artifact reader exited without a result" }));
    child.once("message", (result: ArtifactOutcome) => finish(result));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    const job: ArtifactJob = { root, cwd: relative(root, cwd), kind, path: args.path!, spec: { ...args } };
    child.send(job, error => {
      if (error) finish({ status: "uncheckable", detail: "could not start artifact verification" });
    });
  });
}

