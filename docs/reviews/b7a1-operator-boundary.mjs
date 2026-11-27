// Run with node --import tsx --test docs/reviews/b7a1-operator-boundary.mjs.
// This exercises the existing fork route, before importing any housekeeping feature.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/memory-store.ts';
import { ProfileStore } from '../../src/memory/profile-store.ts';
import { createHttpServer } from '../../src/http/http-server.ts';
import { createRestoreMemoryChangeHandler } from '../../src/http/route-memory-history.ts';

for(const disabled of [false,true]) test(disabled
  ? 'memory.notes.enabled=false makes restoration inert even for the owner'
  : 'a child with an inherited owner key cannot restore a person-deleted note', {timeout:30_000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'b7a1-owner-boundary-'));
  const previousState=process.env.ATOMIC_AGENT_STATE_DIR;
  process.env.ATOMIC_AGENT_STATE_DIR=dir;
  const notes=new MemoryStore({dbFile:join(dir,'memory.sqlite'),maxEntries:100});
  const profile=new ProfileStore({dbFile:join(dir,'memory.sqlite')});
  const note=notes.store({content:'synthetic note deleted by the person'});
  notes.remove(note.id,'user');
  const change=notes.getChangeLog().list()[0];
  assert.equal(change.by,'user');
  const owner='b7a1-synthetic-inherited-owner';
  const config={memory:{notes:{enabled:!disabled},profile:{enabled:!disabled},lessons:{enabled:!disabled},procedures:{enabled:!disabled}}};
  const server=await createHttpServer({runtime:{notesStore:notes,profileStore:profile,config},host:'127.0.0.1',port:0,apiKey:owner,
    routes:[{method:'POST',path:'/api/memory/changes/{id}/restore',scope:'admin',handler:createRestoreMemoryChangeHandler()}]});
  try{
    if(disabled){
      const response=await fetch(`http://127.0.0.1:${server.port}/api/memory/changes/${change.id}/restore`,{method:'POST',headers:{authorization:`Bearer ${owner}`}});
      await response.arrayBuffer();
      assert.deepEqual({restored:notes.get(note.id)!==null,journalRestored:notes.getChangeLog().get(change.id).restoredAt!==null},
        {restored:false,journalRestored:false},'disabled notes must not be restored or mark the journal restored');
      return;
    }
    const {stdout}=await promisify(execFile)(process.execPath,['-e',
      `fetch(process.env.B7A1_URL,{method:'POST',headers:{authorization:'Bearer '+process.env.B7A1_OWNER}}).then(r=>console.log(JSON.stringify({status:r.status}))).catch(()=>process.exit(2));`],
      {env:{...process.env,ATOMIC_AGENT_TOOL_CHILD:'1',B7A1_OWNER:owner,B7A1_URL:`http://127.0.0.1:${server.port}/api/memory/changes/${change.id}/restore`},timeout:20_000});
    assert.deepEqual({status:JSON.parse(stdout.trim()).status,restored:notes.get(note.id)!==null},
      {status:403,restored:false},'an inherited owner key is not a person-mediated restore decision');
  }finally{
    await server.close();notes.close();profile.close();rmSync(dir,{recursive:true,force:true});
    if(previousState===undefined)delete process.env.ATOMIC_AGENT_STATE_DIR;else process.env.ATOMIC_AGENT_STATE_DIR=previousState;
  }
});
