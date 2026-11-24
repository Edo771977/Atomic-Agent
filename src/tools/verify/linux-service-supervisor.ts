import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";

interface ProbeRequest {
  port?: number;
  url?: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

async function probe(request: ProbeRequest): Promise<{ status: number; body: string }> {
  if (request.port !== undefined) {
    const port = request.port;
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve({ status: 200, body: "" });
      });
      socket.once("error", reject);
      socket.setTimeout(1000, () => socket.destroy(new Error("probe timed out")));
    });
  }
  if (request.url === undefined) throw new Error("the service probe requires a port or URL");
  const response = await fetch(request.url, {
    method: request.method,
    body: request.body,
    headers: request.headers,
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.text() };
}

/** Fixed relay for the host verifier and the service sharing this Bubblewrap sandbox. */
export async function serveLinuxServiceProbe([socketPath, command, ...args]: readonly string[]): Promise<number> {
  if (process.platform !== "linux" || process.ppid !== 1 || process.env.ATOMIC_AGENT_TOOL_CHILD !== "1" ||
      readFileSync("/proc/1/comm", "utf8").trim() !== "bwrap" || !socketPath || !command) {
    process.stderr.write("Safe Mode: the verify service probe must be launched inside its Bubblewrap sandbox.\n");
    return 1;
  }
  return await new Promise(resolve => {
    const service = spawn(command, args, { stdio: "inherit" });
    const server = net.createServer({ allowHalfOpen: true }, socket => {
      const chunks: Buffer[] = [];
      let size = 0;
      socket.on("error", () => {});
      socket.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) socket.destroy();
        else chunks.push(chunk);
      });
      socket.once("end", async () => {
        try {
          socket.end(JSON.stringify(await probe(JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProbeRequest)));
        } catch (error) {
          socket.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
    });
    const fail = (error: Error): void => {
      process.stderr.write(`${error.message}\n`);
      resolve(1);
    };
    server.once("error", fail);
    service.once("error", fail);
    service.once("exit", code => resolve(code ?? 1));
    server.listen(socketPath);
  });
}
