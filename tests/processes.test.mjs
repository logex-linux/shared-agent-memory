import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir,writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setup,record,publish } from './helpers.mjs';
import { MemoryService } from '../dist/core/service.js';
await mkdir('test-results',{recursive:true});
async function worker(config,operation,arg) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['tests/process-worker.mjs',config,operation,arg]);let out='',err='';
    child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);
    child.on('exit',(code,signal)=>resolve({code,signal,result:out.trim()?JSON.parse(out.trim()):null,stderr:err}));
  });
}
test('four real processes publish 400 unique requests; retries preserve count and IDs',async()=>{
  const {service,root,config}=await setup();service.close();const path=root+'/config.json';await writeFile(path,JSON.stringify(config));
  const responses=await Promise.all([0,1,2,3].map(i=>worker(path,'write',String(i))));
  for(const r of responses)assert.equal(r.code,0,JSON.stringify(r));
  assert.equal(new Set(responses.flatMap(r=>r.result.ids)).size,400);
  const s=new MemoryService(config);
  try{const count=s.db.prepare('SELECT count(*) n FROM memories').get().n;assert.equal(count,400);assert.equal(s.check().missing_vectors.n,0);assert.equal(s.check().orphan_vectors.n,0);await writeFile('test-results/concurrency.json',JSON.stringify({runtime:process.version,processes:responses.map(r=>r.result),count,unique_ids:new Set(responses.flatMap(r=>r.result.ids)).size,integrity:s.check()},null,2)+'\n');}finally{s.close();}
});
test('two processes competing for same revision publish exactly once',async()=>{
  const {service:s,root,project,config}=await setup();
  const m=await publish(s,record(project));const requests=[];
  for(let i=0;i<2;i++) {const p=await s.propose({request_id:randomUUID(),target_id:m.memory_id,expected_revision:1,record:record(project,{content:`竞争更新 ${i}`})});const path=root+`/request${i}.json`;await writeFile(path,JSON.stringify({request_id:randomUUID(),proposal_id:p.proposal_id,expected_revision:1}));requests.push(path);}
  s.close();const path=root+'/config.json';await writeFile(path,JSON.stringify(config));
  const results=await Promise.all(requests.map(p=>worker(path,'commit',p)));
  assert.equal(results.filter(r=>r.code===0).length,1);assert.equal(results.filter(r=>r.result?.error==='VERSION_CONFLICT').length,1);
  await writeFile('test-results/revision-race.json',JSON.stringify({runtime:process.version,results:results.map(({code,result})=>({code,result}))},null,2)+'\n');
});
test('four clients concurrently migrate a legacy schema without losing records',async()=>{
  const {service:s,root,project,config}=await setup();const m=await publish(s,record(project));
  s.db.exec('ALTER TABLE memories DROP COLUMN written_by; ALTER TABLE proposals DROP COLUMN connection_id; ALTER TABLE events DROP COLUMN connection_id; PRAGMA user_version=3;');s.close();
  const path=root+'/config.json';await writeFile(path,JSON.stringify(config));
  const results=await Promise.all([0,1,2,3].map(()=>worker(path,'inspect','unused')));
  for(const result of results){assert.equal(result.code,0,result.stderr);assert.equal(result.result.schema,5);}
  const check=new MemoryService(config);try{assert.equal((await check.recall({ids:[m.memory_id]})).items.length,1);assert.equal(check.check().missing_vectors.n,0);}finally{check.close();}
});
test('ten SIGKILL interruption points leave no partial memory or orphan index',async()=>{
  const points=['after_embedding','begin','profile','index_delete','row','dependencies','chunks','fts','proposal','receipt'];
  const evidence=[];
  for(const point of points) {
    const {service:s,root,project,config}=await setup();const p=await s.propose({request_id:randomUUID(),record:record(project)});s.close();
    const path=root+'/config.json';await writeFile(path,JSON.stringify(config));await writeFile(path+'.request',JSON.stringify({request_id:randomUUID(),proposal_id:p.proposal_id,expected_revision:0}));
    const result=await worker(path,'crash',point);assert.equal(result.signal,'SIGKILL',point);
    const reopened=new MemoryService(config);
    try{const records=reopened.db.prepare('SELECT count(*) n FROM memories').get().n;assert.equal(records,0,point);const check=reopened.check();assert.equal(check.integrity[0].integrity_check,'ok',point);assert.equal(check.orphan_vectors.n,0,point);assert.equal(check.orphan_chunks.n,0,point);evidence.push({point,signal:result.signal,records,integrity:check});}finally{reopened.close();}
  }
  await writeFile('test-results/fault-recovery.json',JSON.stringify({runtime:process.version,evidence},null,2)+'\n');
});
