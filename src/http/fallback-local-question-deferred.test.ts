import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHttpServer } from "./http-server.js";
import { ROUTE_SCOPES } from "./http-scopes.js";
import { buildRouteTable } from "./route-table.js";
import { hashHttpToken } from "./http-token-store.js";
afterEach(()=>{vi.unstubAllEnvs();});
it.each(["owner","admin","operator","member","viewer","anonymous"] as const)("keeps fallback consent unavailable for %s including inherited owner credentials",async role=>{
  const dir=mkdtempSync(join(tmpdir(),"b7a4-absent-"));
  const config=join(dir,"config.json");const original='{"llm":{"fallback":{"appendLocal":true}}}\n';writeFileSync(config,original);
  vi.stubEnv("ATOMIC_AGENT_TOOL_CHILD","1");vi.stubEnv("ATOMIC_AGENT_STATE_DIR",dir);
  const routes=buildRouteTable();
  expect(routes.filter(route=>route.path.includes("fallback/local-question"))).toEqual([]);
  expect(Object.keys(ROUTE_SCOPES).filter(route=>route.includes("fallback/local-question"))).toEqual([]);
  const server=await createHttpServer({runtime:{} as never,host:"127.0.0.1",port:0,apiKey:"owner-fixture",routes,namedTokens:()=>role==="owner"||role==="anonymous"?[]:[{name:"fixture",role,sha256:hashHttpToken("named-fixture"),createdAt:""}]});
  try{
    for(const offline of ["0","1"]){
      vi.stubEnv("ATOMIC_AGENT_OFFLINE",offline);
      for(const [method,body] of [["GET",undefined],["POST",'{"answer":"keep"}'],["POST",'{"answer":"off"}'],["POST",'{"answer":"off" BROKEN']] as const){
        const response=await fetch(`http://127.0.0.1:${server.port}/api/fallback/local-question`,{method,headers:{"content-type":"application/json",...(role==="anonymous"?{}:{authorization:`Bearer ${role==="owner"?"owner-fixture":"named-fixture"}`})},...(body===undefined?{}:{body})});
        expect(response.status).toBe(404);
      }
    }
    expect(readFileSync(config,"utf8")).toBe(original);expect(readdirSync(dir)).toEqual(["config.json"]);
  }finally{await server.close();rmSync(dir,{recursive:true,force:true});}
});
