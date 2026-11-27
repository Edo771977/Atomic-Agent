import { expect, it } from "vitest";
import { createEmptySessionState } from "../session/session-state.js";
import { createHttpServer } from "./http-server.js";
import { buildRouteTable } from "./route-table.js";
import { hashHttpToken } from "./http-token-store.js";

it.each(["viewer","member","operator","admin"] as const)("conceals incognito and withheld PDF exports from %s",async role=>{
  const state=createEmptySessionState({id:"hidden",workingDir:process.cwd()});
  const runtime={sessionStore:{load:(id:string)=>id==="missing"?null:{...state,id,...(id==="private"?{incognito:{since:1,owner:"fixture"}}:{})}},serveRefusal:()=>"withheld"};
  const server=await createHttpServer({runtime:runtime as never,host:"127.0.0.1",port:0,networkServe:true,apiKey:"owner-fixture",routes:buildRouteTable(),namedTokens:()=>[{name:"fixture",role,sha256:hashHttpToken("named-fixture"),createdAt:""}]});
  try {
    const responses=[];
    for(const id of ["missing","hidden","private"]){
      const response=await fetch(`http://127.0.0.1:${server.port}/api/sessions/${id}/export?format=pdf`,{headers:{authorization:"Bearer named-fixture"}});
      expect(response.status).toBe(404);responses.push(await response.json());
    }
    expect(responses[1]).toEqual(responses[0]);expect(responses[2]).toEqual(responses[0]);
  }finally{await server.close();}
});
