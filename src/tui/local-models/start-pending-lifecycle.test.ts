import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getConfig, resetConfigCache } from "../../config/index.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";
import type { ModelOperationQueue } from "./model-operation-queue.js";
let dir: string;
let modelsDir: string;
beforeEach(()=>{
  dir=mkdtempSync(join(tmpdir(),"b7a5-start-"));
  vi.stubEnv("ATOMIC_AGENT_STATE_DIR",dir);resetConfigCache();
  modelsDir=getConfig().paths.localModelsDataDir;
  getConfig().localModels.mode = "managed";
  expect(modelsDir).toBe(join(dir,"models"));
  mkdirSync(modelsDir,{recursive:true});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();resetConfigCache();rmSync(dir,{recursive:true,force:true});});
function fixture(){
  const orchestrator=new LocalModelsOrchestrator({emit(){},subscribe:()=>()=>{}});
  const internals=orchestrator as unknown as {startDaemonNow:(opts:{signal:AbortSignal})=>Promise<boolean>;operations:ModelOperationQueue};
  return {orchestrator,internals,path:join(modelsDir,"chat-start.pending")};
}
it("does not write a start marker or create its directory in external mode", async () => {
  getConfig().localModels.mode = "external";
  const { orchestrator, internals, path } = fixture();
  rmSync(modelsDir, { recursive: true, force: true });
  vi.spyOn(internals, "startDaemonNow").mockImplementation(async () => {
    expect(existsSync(path)).toBe(false);
    expect(existsSync(modelsDir)).toBe(false);
    return false;
  });
  expect(await orchestrator.startDaemon()).toBe(false);
  expect(existsSync(modelsDir)).toBe(false);
});
it.each([true,false])("holds the marker before backend work and removes it after a thrown start (directory exists: %s)",async directoryExists=>{
  const {orchestrator,internals,path}=fixture();
  if(!directoryExists) rmSync(modelsDir,{recursive:true,force:true});
  vi.spyOn(internals,"startDaemonNow").mockImplementation(async()=>{
    expect(readFileSync(path,"utf8")).toBe(String(process.pid));
    throw new Error("synthetic backend failure");
  });
  await expect(orchestrator.startDaemon()).rejects.toThrow("synthetic backend failure");
  expect(existsSync(path)).toBe(false);
});
it("keeps the marker until shutdown cancellation settles the in-flight start",async()=>{
  const {orchestrator,internals,path}=fixture();
  let entered!: () => void;
  const entering=new Promise<void>(resolve=>{entered=resolve;});
  vi.spyOn(internals,"startDaemonNow").mockImplementation(({signal})=>new Promise(resolve=>{
    signal.addEventListener("abort",()=>resolve(false),{once:true});entered();
  }));
  const starting=orchestrator.startDaemon();
  await entering;
  try{expect(existsSync(path)).toBe(true);}finally{await internals.operations.close();await starting;}
  expect(existsSync(path)).toBe(false);
});
