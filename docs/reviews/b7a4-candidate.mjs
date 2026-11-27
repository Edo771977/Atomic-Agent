// Direct audit of the candidate persistence owner; no production files are copied.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureUserConfigFileSync, readUserConfigFileSync, writeUserConfigFileSync } from '../../src/config/config-file.ts';
import { parseLlmFallbackConfig } from '../../src/config/llm-config.ts';
import { USER_CONFIG_VERSION } from '../../src/config/config-schema.ts';
import { resetConfigCache } from '../../src/config/config-cache.ts';
import { createHttpServer } from '../../src/http/http-server.ts';
import { readJsonBody, sendError, sendJson } from '../../src/http/request-context.ts';
import { openaiError } from '../../src/http/openai-errors.ts';
const text=execFileSync('git',['show','--no-textconv','f72e0a38446352115cde15cebe42c4ffadee498d:src/runtime/append-local-question.ts'],{encoding:'utf8'});
const body=text.replace(/^import[\s\S]*?from\s+"[^"]+";\r?\n/gm,'').replaceAll('export ','');
const configSource=execFileSync('git',['show','--no-textconv','f72e0a38446352115cde15cebe42c4ffadee498d:src/config/llm-provider-commands.ts'],{encoding:'utf8'});
const setter=configSource.slice(configSource.indexOf('export function setFallbackAppendLocalInConfig('),configSource.indexOf('\nexport function wrapLlmConfigError(')).replace('export ','');
for(const answer of ['keep','off']) test(`marked child cannot persist ${answer}`,()=>{
  const dir=fs.mkdtempSync(join(tmpdir(),'b7a4-candidate-'));
  const config=join(dir,'config.json');const original=JSON.stringify({version:USER_CONFIG_VERSION,llm:{activeTextProvider:'local-llama',providers:[{id:'local-llama',kind:'llama-server'}],fallback:{appendLocal:true}}});fs.writeFileSync(config,original);
  const previous=process.env.ATOMIC_AGENT_TOOL_CHILD;process.env.ATOMIC_AGENT_TOOL_CHILD='1';
  const context=vm.createContext({...fs,join,randomBytes,process,readUserConfigFileSync,ensureUserConfigFileSync,writeUserConfigFileSync,parseLlmFallbackConfig,resetConfigCache});
  try{
    vm.runInContext(stripTypeScriptTypes(setter+'\n'+body)+'\nglobalThis.answer=answerAppendLocalQuestion;',context);
    try{context.answer({userConfigFile:config,stateDir:dir},answer);}catch{}
    assert.equal(JSON.parse(fs.readFileSync(config,'utf8')).llm.fallback.appendLocal,true,'child changed persistent fallback');
    assert.equal(fs.readFileSync(config,'utf8'),original,'child changed persistent config');
    assert.equal(fs.existsSync(join(dir,'append-local-question.json')),false,'child recorded operator consent');
  }finally{if(previous===undefined)delete process.env.ATOMIC_AGENT_TOOL_CHILD;else process.env.ATOMIC_AGENT_TOOL_CHILD=previous;fs.rmSync(dir,{recursive:true,force:true});}
});

test('a child with an inherited owner key cannot answer over the admin HTTP route', {timeout:30_000}, async()=>{
  const dir=fs.mkdtempSync(join(tmpdir(),'b7a4-http-candidate-'));
  const config=join(dir,'config.json');
  fs.writeFileSync(config,JSON.stringify({version:USER_CONFIG_VERSION,llm:{activeTextProvider:'local-llama',providers:[{id:'local-llama',kind:'llama-server'}],fallback:{appendLocal:true}}}));
  const routeSource=execFileSync('git',['show','--no-textconv','f72e0a38446352115cde15cebe42c4ffadee498d:src/http/route-fallback-local-question.ts'],{encoding:'utf8'});
  const routeBody=routeSource.replace(/^import[\s\S]*?from\s+"[^"]+";\r?\n/gm,'').replaceAll('export ','');
  const context=vm.createContext({...fs,join,randomBytes,process,readUserConfigFileSync,ensureUserConfigFileSync,writeUserConfigFileSync,parseLlmFallbackConfig,resetConfigCache,
    getConfig:()=>({paths:{userConfigFile:config,stateDir:dir}}),readJsonBody,sendError,sendJson,openaiError});
  vm.runInContext(stripTypeScriptTypes(setter+'\n'+body+'\n'+routeBody)+'\nglobalThis.handler=createFallbackLocalQuestionAnswerHandler();',context);
  const owner='b7a4-synthetic-inherited-owner';
  const server=await createHttpServer({runtime:{},host:'127.0.0.1',port:0,apiKey:owner,routes:[{method:'POST',path:'/api/fallback/local-question',scope:'admin',handler:context.handler}]});
  try{
    const {stdout}=await promisify(execFile)(process.execPath,['-e',
      `fetch(process.env.B7A4_URL,{method:'POST',headers:{authorization:'Bearer '+process.env.B7A4_OWNER,'content-type':'application/json'},body:JSON.stringify({answer:'off'})}).then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()}))).catch(()=>process.exit(2));`],
      {env:{...process.env,ATOMIC_AGENT_STATE_DIR:dir,ATOMIC_AGENT_TOOL_CHILD:'1',B7A4_OWNER:owner,B7A4_URL:`http://127.0.0.1:${server.port}/api/fallback/local-question`},timeout:20_000});
    const response=JSON.parse(stdout.trim());
    assert.deepEqual({status:response.status,appendLocal:JSON.parse(fs.readFileSync(config,'utf8')).llm.fallback.appendLocal,answerFile:fs.existsSync(join(dir,'append-local-question.json'))},
      {status:403,appendLocal:true,answerFile:false},'inherited owner credentials are not operator consent');
  }finally{await server.close();fs.rmSync(dir,{recursive:true,force:true});}
});
