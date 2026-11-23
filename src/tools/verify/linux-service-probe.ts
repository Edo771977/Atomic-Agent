import net from "node:net";
import { isSea } from "node:sea";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { resolveInvocation } from "./spawn-verify-process.js";

interface ProbeRequest {
  port?: number;
  url?: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

interface ProbeResult {
  status: number;
  body: string;
}

const MAX_PROBE_BYTES = 2 * 1024 * 1024;

/** A trusted launcher file needed when the source checkout sits under the hidden home. */
export function linuxServiceSupervisorPath(): string | undefined {
  if (isSea()) return undefined;
  return fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./linux-service-supervisor.ts" : "./linux-service-supervisor.js", import.meta.url));
}

export function linuxServiceInvocation(
  invocation: ReturnType<typeof resolveInvocation>,
  socketPath: string,
): ReturnType<typeof resolveInvocation> {
  const args = [socketPath, invocation.command, ...invocation.args];
  const supervisor = linuxServiceSupervisorPath();
  if (supervisor === undefined) return { ...invocation, command: process.execPath, args: ["--internal-verify-service", ...args] };
  const entry = pathToFileURL(supervisor).href;
  return {
    ...invocation,
    command: process.execPath,
    args: ["--input-type=module", "-e",
      "const {serveLinuxServiceProbe} = await import(process.argv[1]); process.exit(await serveLinuxServiceProbe(process.argv.slice(2)));",
      "--", entry, ...args],
  };
}

export async function probeLinuxService(
  socketPath: string,
  request: ProbeRequest,
  signal: AbortSignal,
): Promise<ProbeResult> {
  signal.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const abort = (): void => { socket.destroy(signal.reason instanceof Error ? signal.reason : new Error("probe aborted")); };
    const chunks: Buffer[] = [];
    let size = 0;
    signal.addEventListener("abort", abort, { once: true });
    socket.once("close", () => {
      signal.removeEventListener("abort", abort);
    });
    socket.once("error", reject);
    socket.once("connect", () => socket.end(JSON.stringify(request)));
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PROBE_BYTES) socket.destroy(new Error("the sandbox service response exceeded the probe limit"));
      else chunks.push(chunk);
    });
    socket.once("end", () => {
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProbeResult | { error: string };
        if ("error" in response) reject(new Error(response.error));
        else resolve(response);
      } catch (error) {
        reject(error);
      }
    });
  });
}
