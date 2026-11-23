import net from "node:net";
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

/** The service and its probe share one sandbox. Only the probe's Unix socket crosses the mount boundary. */
const SUPERVISOR = `
const { spawn } = require("node:child_process");
const net = require("node:net");
const [socketPath, command, ...args] = process.argv.slice(1);
const service = spawn(command, args, { stdio: "inherit" });

async function probe(request) {
  if (request.port !== undefined) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: request.port });
      socket.once("connect", () => {
        socket.destroy();
        resolve({ status: 200, body: "" });
      });
      socket.once("error", reject);
      socket.setTimeout(1000, () => socket.destroy(new Error("probe timed out")));
    });
  }
  const response = await fetch(request.url, {
    method: request.method,
    body: request.body,
    headers: request.headers,
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.text() };
}

const server = net.createServer({ allowHalfOpen: true }, socket => {
  const chunks = [];
  let size = 0;
  socket.on("error", () => {});
  socket.on("data", chunk => {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) socket.destroy();
    else chunks.push(chunk);
  });
  socket.once("end", async () => {
    try {
      const result = await probe(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      socket.end(JSON.stringify(result));
    } catch (error) {
      socket.end(JSON.stringify({ error: error.message }));
    }
  });
});
server.on("error", error => {
  console.error(error.message);
  process.exit(1);
});
service.on("error", error => {
  console.error(error.message);
  process.exit(1);
});
service.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
server.listen(socketPath);
`;

export function linuxServiceInvocation(
  invocation: ReturnType<typeof resolveInvocation>,
  socketPath: string,
): ReturnType<typeof resolveInvocation> {
  return {
    ...invocation,
    command: process.execPath,
    args: ["-e", SUPERVISOR, "--", socketPath, invocation.command, ...invocation.args],
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
