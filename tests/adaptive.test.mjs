import test from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {writeFile,readFile} from 'node:fs/promises';import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {MemoryService} from '../dist/core/service.js';import {recallSchema} from '../dist/core/contracts.js';
import {setup,record,publish} from './helpers.mjs';import {fake,seed,collect} from './adaptive-helpers.mjs';
const worker=(path,operation,arg)=>new Promise((resolve,reject)=>{const c=spawn(process.execPath,['tests/adaptive-worker.mjs',path,operation,JSON.stringify(arg??{})]);let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);c.on('error',reject);c.on('exit',(code,signal)=>resolve({code,signal,result:out.trim()?JSON.parse(out):null,err}));});

test('focused returns a single relevant fact; normal responses omit diagnostics; legacy limit accepts large page requests',async()=>{
 const {service:s,project}=await setup();s.encoder=fake;
 try{seed(s,[project],1000,{relevant:false});const [gold]=seed(s,[project],1);const r=await s.recall({query:'设计偏好',mode:'focused'});assert.deepEqual(r.items.map(i=>i.id),[gold]);assert.equal(r.has_more,false);assert.equal(r.diagnostics,undefined);assert.equal(r.items[0].verification.status,'unverified');assert.ok(r.items[0].sources.length);assert.equal(recallSchema.parse({query:'x',limit:100000}).limit,100000);}finally{s.close();}
});

test('broad exceeds Top20 and retrieves 160 accessible relevant records across pages without loading any full body',async()=>{
 const {service:s,project,other}=await setup({page_candidate_budget:64,page_item_limit:17});s.encoder=fake;let embeddings=0;s.encoder={...fake,query:async()=>{embeddings++;return fake.query();}};
 try{seed(s,[project],1500,{relevant:false});const gold=seed(s,[project,other,null],160),invalid=seed(s,[project],40,{valid_for:{expires_at:'2020-01-01T00:00:00.000Z'}});seed(s,[project],40,{valid_for:{environment:'wrong'}});
  const result=await collect(s,{query:'长期设计偏好',mode:'broad',view:'evidence',context:{environment:'right'},debug:true,limit:17});assert.deepEqual(new Set(result.ids),new Set(gold));assert.ok(result.pages.length>=Math.ceil(gold.length/17));assert.equal(embeddings,1);for(const r of result.pages){assert.equal(r.diagnostics.full_body_records_read,0);assert.ok(r.diagnostics.metadata_json_parses<=18);assert.ok(r.items.length<=17);assert.ok(r.items.every(i=>!invalid.includes(i.id)));assert.ok(Buffer.byteLength(JSON.stringify(r))<=32000);}
  assert.ok(result.pages[0].retrieval.coverage.projects>=2);assert.ok(result.pages.at(-1).retrieval.coverage.periods>=10);assert.equal(result.pages.at(-1).retrieval.stop_reason,'exhausted');
 }finally{s.close();}
});

test('pagination is resumable, deterministic and query/authority bound across restart and four processes',async()=>{
 const {service:s,project,other,config,root}=await setup({page_item_limit:8});s.encoder=fake;seed(s,[project,other],66);const first=await s.recall({query:'设计偏好',mode:'broad',limit:6});s.close();const path=root+'/reader.json';await writeFile(path,JSON.stringify(config));
 const replay=await Promise.all([0,1,2,3].map(()=>worker(path,'page',{cursor:first.next_cursor})));for(const r of replay){assert.equal(r.code,0,r.err);assert.deepEqual(r.result.items.map(i=>i.id),replay[0].result.items.map(i=>i.id));assert.ok(r.result.items.every(i=>!first.items.some(j=>j.id===i.id)));}
 const reopened=new MemoryService(config,fake);try{
  const a=await reopened.recall({cursor:first.next_cursor});assert.deepEqual(a.items.map(i=>i.id),replay[0].result.items.map(i=>i.id));assert.equal(a.diagnostics,undefined);
  await assert.rejects(reopened.recall({cursor:first.next_cursor,project_id:other}),{code:'CURSOR_QUERY_MISMATCH'});
  await assert.rejects(reopened.recall({cursor:first.next_cursor,mode:'focused'}),{code:'CURSOR_QUERY_MISMATCH'});
  await assert.rejects(reopened.recall({cursor:first.next_cursor,limit:5}),{code:'CURSOR_PAGE_OPTIONS_MISMATCH'});
  const reader=new MemoryService({...config,allowed_projects:[project],allow_global:false},fake);try{await assert.rejects(reader.recall({cursor:first.next_cursor}),{code:'CURSOR_SCOPE_CHANGED'});}finally{reader.close();}
 }finally{reopened.close();}
});

test('project/global filters apply throughout many pages; concurrent readers do not borrow another query scope',async()=>{
 const {service:s,project,other,config,root}=await setup();s.encoder=fake;const gold=seed(s,[project],58);seed(s,[other,null],80);s.close();const path=root+'/narrow.json';await writeFile(path,JSON.stringify({...config,allowed_projects:[project],allow_global:false}));
 const results=await Promise.all([0,1,2,3].map(()=>worker(path,'collect',{query:'设计偏好',mode:'broad',limit:7})));for(const r of results){assert.equal(r.code,0,JSON.stringify(r));assert.deepEqual(new Set(r.result.ids),new Set(gold));}
});

test('new, revised and forgotten records invalidate cursors; concurrent writers cannot expose old revisions',async()=>{
 for(const mutation of ['new','update','forget']){
  const {service:s,project,config,root}=await setup();s.encoder=fake;seed(s,[project],60);const first=await s.recall({query:'设计偏好',mode:'broad',limit:3}),target=first.items[0];
  try{
   if(mutation==='new'){const path=root+'/writer.json';await writeFile(path,JSON.stringify(config));const concurrent=await Promise.all([worker(path,'write'),worker(path,'page',{cursor:first.next_cursor})]);assert.equal(concurrent[0].code,0,JSON.stringify(concurrent));if(concurrent[1].code!==0)assert.equal(concurrent[1].result.error,'CURSOR_STALE');}
   else if(mutation==='update')await publish(s,record(project,{title:'设计偏好修订',content:'仅保留新版本内容'}),{target_id:target.id,expected_revision:target.revision});
   else await s.forget({request_id:randomUUID(),memory_id:target.id,expected_revision:target.revision});
   await assert.rejects(s.recall({cursor:first.next_cursor}),{code:'CURSOR_STALE'});
   await assert.rejects(s.recall({cursor:first.next_cursor.replace(/:\d+$/,':0')}),{code:'CURSOR_STALE'});
   const current=await collect(s,{query:'设计偏好',mode:'broad'});assert.ok(current.pages.flatMap(p=>p.items).filter(i=>i.id===target.id).every(i=>mutation==='update'?i.revision===2:mutation!=='forget'));
  }finally{s.close();}
 }
});

test('TTL, expired records, unknown cursor, index damage, and incomplete page creation fail explicitly',async()=>{
 const {service:s,project,config,root}=await setup({query_ttl_seconds:1});s.encoder=fake;seed(s,[project],60);let first=await s.recall({query:'设计偏好',mode:'broad',limit:3});
 try{
  await assert.rejects(s.recall({cursor:'am4:'+randomUUID()+':1'}),{code:'CURSOR_EXPIRED'});await assert.rejects(s.recall({cursor:'bad'}),{code:'CURSOR_INVALID'});
  const cache=new DatabaseSync(config.database+'.retrieval.db');cache.prepare('UPDATE queries SET expires=0').run();cache.close();await assert.rejects(s.recall({cursor:first.next_cursor}),{code:'CURSOR_EXPIRED'});
  first=await s.recall({query:'设计偏好',mode:'broad',limit:3});s.db.prepare('DELETE FROM memory_vec WHERE chunk_id=(SELECT min(chunk_id) FROM memory_vec)').run();await assert.rejects(s.recall({cursor:first.next_cursor}),{code:'CURSOR_INDEX_CHANGED'});
  const degraded=await s.recall({query:'设计偏好',mode:'broad'});assert.equal(degraded.retrieval_mode,'lexical_degraded');assert.ok(degraded.warnings.includes('INDEX_INCOMPLETE'));
  const path=root+'/crash.json';await writeFile(path,JSON.stringify(config));const crash=await worker(path,'crash',{query:'设计偏好',mode:'broad'});assert.equal(crash.signal,'SIGKILL');const after=await collect(s,{query:'设计偏好',mode:'broad'});assert.equal(after.ids.length,60);assert.equal(s.check().integrity[0].integrity_check,'ok');
 }finally{s.close();}
});

test('an expired pending item cannot trap pagination and a replay cannot return expired evidence',async()=>{
 const {service:s,project,config}=await setup();s.encoder=fake;
 try{seed(s,[project],65);const first=await s.recall({query:'设计偏好',mode:'broad',limit:2});
  // Time passing changes applicability without advancing generation.
  s.db.prepare("UPDATE memory_search SET expires_at='2020-01-01T00:00:00.000Z'").run();
  await assert.rejects(s.recall({cursor:first.next_cursor.replace(/:\d+$/,':0')}),{code:'CURSOR_STALE'});
  const rest=await collect(s,{cursor:first.next_cursor});assert.equal(rest.ids.length,0);assert.equal(rest.pages.at(-1).has_more,false);
 }finally{s.close();}
});

test('page budgets keep source markers; debug does not consume the content budget; evidence lists allow selective expansion',async()=>{
 const {service:s,project}=await setup();s.encoder=fake;seed(s,[project],55);
 try{const a=await s.recall({query:'设计偏好',mode:'broad',view:'evidence',limit:20,token_budget:1200}),cursor=a.next_cursor.replace(/:\d+$/,':0'),b=await s.recall({cursor,debug:true});assert.deepEqual(a.items,b.items);assert.ok(!a.diagnostics);assert.ok(b.diagnostics.content_estimated_tokens<=1200);assert.ok(Buffer.byteLength(JSON.stringify(b))<=32000);assert.ok(b.items.every(i=>i.content.length<=200&&i.sources.length));const expanded=await s.recall({ids:[b.items[0].id]});assert.equal(expanded.items[0].id,b.items[0].id);
 }finally{s.close();}
});

test('embedding failure is explicit and lexical broad pagination still exhausts all matching evidence',async()=>{
 const {service:s,project}=await setup();s.encoder=fake;const gold=seed(s,[project],57);s.encoder={...fake,query:async()=>{throw Error('broken model');}};
 try{const r=await collect(s,{query:'设计偏好',mode:'broad',limit:5});assert.deepEqual(new Set(r.ids),new Set(gold));assert.ok(r.pages.every(p=>p.retrieval_mode==='lexical_degraded'&&p.warnings.includes('EMBEDDING_UNAVAILABLE')));}finally{s.close();}
});

test('auto expands from a multi-context preference distribution and cursor preserves the original page size',async()=>{
 const {service:s,project,other}=await setup();s.encoder=fake;seed(s,[project,other],75);
 try{const r=await s.recall({query:'设计素材查找',limit:4});assert.equal(r.retrieval.mode,'broad');const rest=await collect(s,{cursor:r.next_cursor});assert.ok(rest.pages.every(p=>p.items.length<=4));assert.equal(r.items.length+rest.ids.length,75);}finally{s.close();}
});

test('an oversized sourced record can resume with a larger page budget; expiry precision and narrower replay budgets are enforced',async()=>{
 const {service:s,project,config}=await setup();s.encoder=fake;
 try{
  const m=await publish(s,record(project,{title:'设计偏好',content:'设计偏好：易读的页面。',sources:[{source_type:'test',uri:'test://'+ 'a'.repeat(1300),locator:'synthetic',revision_ref:'1',checked_at:'2025-01-01T00:00:00.000Z'}]}));
  const blocked=await s.recall({query:'设计偏好',mode:'broad',token_budget:512,max_bytes:2048});assert.equal(blocked.items.length,0);assert.equal(blocked.has_more,true);assert.equal(blocked.retrieval.stop_reason,'item_exceeds_budget');assert.deepEqual(blocked.blocked_ids,[m.memory_id]);
  const fit=await s.recall({cursor:blocked.next_cursor,token_budget:6000,max_bytes:32000});assert.equal(fit.items[0].id,m.memory_id);assert.equal(fit.items[0].sources[0].uri.length,1307);
  const tighter=new MemoryService({...config,response_token_budget:512},fake);try{await assert.rejects(tighter.recall({cursor:blocked.next_cursor}),{code:'CURSOR_PAGE_BUDGET_CHANGED'});}finally{tighter.close();}
  s.db.prepare('UPDATE memory_search SET expires_at=? WHERE memory_id=?').run(new Date().toISOString().replace(/\.\d+Z$/,'Z'),m.memory_id);assert.equal((await s.recall({ids:[m.memory_id]})).items.length,0);
 }finally{s.close();}
});
