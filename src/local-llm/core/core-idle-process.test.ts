import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CoreControlClient } from "./core-client.js";
import { shutdownIdleCoreClient } from "./core-idle.js";
import { CORE_VERSION, CORE_PROTOCOL } from "./core-state.js";
import { chatStartPendingPath, withChatStartPending } from "../server/chat-start-pending.js";

const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill(); await closed;
    }
  }
});

/** A real disposable process speaking only the Core control routes under test. */
async function controlProcess(diffusion: "loaded" | "idle" | "absent") {
  const child = spawn(process.execPath, ["-e", `
    const http=require('node:http');
    let held=false; let loaded=${JSON.stringify(diffusion)};
    const server=http.createServer((req,res)=>{
      if(req.headers.authorization!=='Bearer fixture-token'){res.writeHead(401).end();return;}
      res.setHeader('connection','close');
      const path=req.url.replace('/atomic/v1','');
      let body={};
      if(path==='/clients') {held=true; body={client:{id:'lease'}};}
      else if(path==='/snapshot') body={instance_id:'fixture',version:${JSON.stringify(CORE_VERSION)},protocol:${CORE_PROTOCOL},owner_scope:'cli',sessions:[]};
      else if(path==='/embedding/status') body={enabled:false};
      else if(path==='/diffusion/status') {
        if(loaded==='absent'){res.writeHead(404).end('{}');return;}
        body={model:{loaded:loaded==='loaded'?{modelId:'studio-fixture'}:null}};
      } else if(path==='/test/unload') loaded='idle';
      else if(path==='/test/lease') body={held};
      else if(path==='/clients/lease' && req.method==='DELETE') {held=false; body={released:true};}
      else if(path==='/shutdown') { res.end(JSON.stringify({ok:true})); server.close(); return; }
      else {res.writeHead(404).end('{}');return;}
      res.setHeader('content-type','application/json');res.end(JSON.stringify(body));
    });
    server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)+'\\n'));
  `], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const [chunk] = await once(child.stdout!, "data") as [Buffer];
  const port = Number(chunk.toString().trim());
  expect(port).toBeGreaterThan(0);
  const client = new CoreControlClient(`http://127.0.0.1:${port}`, "fixture-token", CORE_VERSION, "fixture");
  return { child, client };
}

it("keeps the actual process alive for Studio, then shuts it down after unload", async () => {
  const { child, client } = await controlProcess("loaded");
  expect(await shutdownIdleCoreClient(client)).toBe(false);
  expect(child.exitCode).toBeNull();
  expect((await client.call<{ held: boolean }>("/test/lease")).held).toBe(false);
  await client.call("/test/unload", {});
  const exited = once(child, "close");
  expect(await shutdownIdleCoreClient(client)).toBe(true);
  await exited;
  expect(child.exitCode).toBe(0);
});

it.each(["idle", "absent"] as const)("retires an actual idle process with diffusion %s", async (mode) => {
  const { child, client } = await controlProcess(mode);
  const exited = once(child, "close");
  expect(await shutdownIdleCoreClient(client)).toBe(true);
  await exited;
  expect(child.exitCode).toBe(0);
});

it("clears the startup marker after an actual Core process dies and does not remember its diffusion state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "w31-core-marker-"));
  try {
    await expect(withChatStartPending(dir, async () => {
      const { child, client } = await controlProcess("loaded");
      expect(existsSync(chatStartPendingPath(dir))).toBe(true);
      expect(await shutdownIdleCoreClient(client)).toBe(false);
      const exited = once(child, "close"); child.kill(); await exited;
      // A dead endpoint cannot claim it shut down; no cached loaded state is stored.
      expect(await shutdownIdleCoreClient(client).catch(() => false)).toBe(false);
      throw new Error("fixture Core died");
    })).rejects.toThrow("fixture Core died");
    expect(existsSync(chatStartPendingPath(dir))).toBe(false);
    const next = await controlProcess("idle");
    const exited = once(next.child, "close");
    expect(await shutdownIdleCoreClient(next.client)).toBe(true);
    await exited;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
