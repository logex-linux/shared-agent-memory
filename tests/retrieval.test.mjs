import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import {writeFile,copyFile,mkdir} from 'node:fs/promises';
import {DatabaseSync,backup} from 'node:sqlite';import * as vec from 'sqlite-vec';
import {spawnSync} from 'node:child_process';
import {MemoryService} from '../dist/core/service.js';import {indexChunk} from '../dist/retrieval/indexes.js';
import {setup,record,publish} from './helpers.mjs';
const vector=(a=1,b=0)=>{const v=new Float32Array(512);v[0]=a;v[1]=b;return v;};
const fake={profile:async()=>({id:'deterministic-test',manifest:{test:true}}),query:async()=>vector(),chunks:async(title,text)=>[{start:0,end:text.length,text,tokens:10,vector:vector()}]};
function seed(s,project,count,{start=0,gold=false,body='无关库存登记',v=vector(0,1),valid_for={}}={}){
 const rows=[];s.storage.transaction(()=>{
  s.db.prepare('INSERT OR IGNORE INTO embedding_profiles VALUES(?,?)').run('deterministic-test','{}');
  const insert=s.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<count;i++){
   const id=randomUUID(),r=record(project,{title:gold?'目标经验':'库存登记 '+(start+i),content:gold?'目标经验正文':body+' '+(start+i),valid_for});
   insert.run(id,project,project?'project':'global',JSON.stringify(r),1,'active','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','deterministic-test','fixture:'+id,null,'test');
   const c=s.db.prepare('INSERT INTO memory_chunks(memory_id,revision,start,end,tokens,text,profile_id) VALUES(?,1,0,?,10,?,?)').run(id,r.content.length,r.content,'deterministic-test');
   s.db.prepare('INSERT INTO memory_vec VALUES(?,?,?)').run(BigInt(c.lastInsertRowid),Buffer.from(v.buffer),project??'global');indexChunk(s.db,{id:Number(c.lastInsertRowid),memory_id:id,text:r.content},r.title,r.tags);s.db.prepare('INSERT INTO memories_fts VALUES(?,?)').run(id,r.title+' '+r.content);rows.push({id,chunk:Number(c.lastInsertRowid)});
  }
 });return rows;
}

test('10,000 visible memories: bounded candidates, zero body transfer and bounded JSON; selective authorization precedes KNN',async()=>{
 const {service:s,project,other,config}=await setup();s.encoder=fake;
 try{
  seed(s,project,9999);const [gold]=seed(s,project,1,{gold:true,v:vector()});
  const prepare=s.db.prepare.bind(s.db);let bodies=0,parses=0;const parse=JSON.parse;
  s.db.prepare=function(sql){assert.ok(!/SELECT\s+\*/i.test(sql),sql);const stmt=prepare(sql);for(const name of ['get','all']){const call=stmt[name].bind(stmt);stmt[name]=(...args)=>{const r=call(...args);for(const row of name==='all'?r:r?[r]:[])if(Object.hasOwn(row,'body'))bodies++;return r;};}return stmt;};
  JSON.parse=(...args)=>{parses++;return parse(...args);};
  let r;try{r=await s.recall({project_id:project,query:'自然语言语义问题',debug:true},'vector');}finally{JSON.parse=parse;s.db.prepare=prepare;}
  assert.deepEqual(r.items.map(i=>i.id),[gold.id]);assert.equal(bodies,0);assert.equal(r.diagnostics.full_body_records_read,0);assert.ok(parses<=6, `bounded metadata and query-state parses: ${parses}`);assert.equal(r.diagnostics.metadata_json_parses,1);assert.ok(r.diagnostics.json_parses<=6);assert.ok(r.diagnostics.vector_rows_returned<=40);assert.equal(r.diagnostics.vector_internal_scanned,null);assert.equal(r.diagnostics.vector_distance_computations,null);
  assert.equal(r.diagnostics.response_bytes,Buffer.byteLength(JSON.stringify(r)));assert.equal(r.diagnostics.estimated_tokens,Math.ceil(Buffer.byteLength(JSON.stringify(r))/3));
  // 9,999 now-inaccessible nearer vectors cannot displace the legal but less similar hit.
  s.db.prepare('UPDATE memories SET project_id=? WHERE id!=?').run(other,gold.id);
  s.db.prepare('UPDATE memory_vec SET embedding=? WHERE chunk_id=?').run(Buffer.from(vector(.8,.6).buffer),BigInt(gold.chunk));
  s.db.prepare('UPDATE memory_vec SET embedding=? WHERE chunk_id!=?').run(Buffer.from(vector().buffer),BigInt(gold.chunk));
  const restricted=new MemoryService({...config,allowed_projects:[project],allow_global:false},fake);
  try{const selected=await restricted.recall({query:'自然语言语义问题',debug:true},'vector');assert.deepEqual(selected.items.map(i=>i.id),[gold.id]);assert.equal(selected.diagnostics.vector_rows_returned,1);await assert.rejects(restricted.recall({project_id:other,query:'q'}),{code:'SCOPE_DENIED'});}finally{restricted.close();}
 }finally{s.close();}
});

test('expiry, environment, cross-project and global predicates are applied before candidate limits',async()=>{
 const {service:s,project,other,config}=await setup();s.encoder=fake;
 try{
  seed(s,project,100,{valid_for:{expires_at:'2020-01-01T00:00:00Z'},v:vector()});seed(s,project,100,{valid_for:{environment:'wrong'},v:vector()});
  const [gold]=seed(s,project,1,{gold:true,v:vector(.8,.6),valid_for:{environment:'right'}}),[global]=seed(s,null,1,{gold:true,v:vector(.9,Math.sqrt(.19))}),[otherHit]=seed(s,other,1,{gold:true,v:vector()});
  let r=await s.recall({project_id:project,query:'语义任务',context:{environment:'right'}},'vector');assert.deepEqual(r.items.map(i=>i.id),[gold.id]);assert.equal(r.items[0].applicability,'current');
  r=await s.recall({project_id:project,include_global:true,query:'语义任务',context:{environment:'right'}},'vector');assert.deepEqual(new Set(r.items.map(i=>i.id)),new Set([gold.id,global.id]));
  const [unregistered]=seed(s,randomUUID(),1,{gold:true,v:vector()});
  const shared=new MemoryService({...config,all_projects:true},fake);try{r=await shared.recall({query:'语义任务',context:{environment:'right'}},'vector');assert.ok(r.items.some(i=>i.id===otherHit.id));assert.ok(r.items.every(i=>i.valid_for.environment!=='wrong'));assert.ok(!r.items.some(i=>i.id===unregistered.id));}finally{shared.close();}
  const missing=await s.recall({ids:[gold.id]});assert.equal(missing.items[0].applicability,'requires_check');
  const [ephemeral]=seed(s,project,1,{gold:true,v:vector(),valid_for:{expires_at:new Date(Date.now()+40).toISOString()}});
  s.encoder={...fake,query:async()=>{await new Promise(resolve=>setTimeout(resolve,100));return vector();}};
  const afterEncoding=await s.recall({project_id:project,query:'语义任务',context:{environment:'right'}},'vector');assert.ok(!afterEncoding.items.some(i=>i.id===ephemeral.id));
 }finally{s.close();}
});

test('a late real BGE chunk, code path and function identifier are recalled without expanding its body',async()=>{
 const {service:s,project}=await setup({semantic_threshold:.425});
 try{
  const content='开篇日常工作记录。'.repeat(180)+'\n报告导出最终失败时，检查 /var/log/agent/late-export.log 中的 ERR_LATE_EXPORT。修复 src/core/reader.ts 的 readMemory() 输出编码后重新校验报告。';
  const m=await publish(s,record(project,{title:'长期设备日志',content}));
  for(const query of ['ERR_LATE_EXPORT','/var/log/agent/late-export.log','src/core/reader.ts','readMemory()']){
   const r=await s.recall({query,exact_only:true,debug:true});assert.equal(r.items[0].id,m.memory_id);assert.ok(r.items[0].excerpts.some(e=>e.start>1000));assert.ok(r.items[0].content.includes('ERR_LATE_EXPORT'));assert.ok(r.items[0].content.length<content.length);assert.equal(r.diagnostics.full_body_records_read,0);assert.ok(r.diagnostics.chunk_text_rows_read<=2);assert.equal(r.items[0].sources[0].uri,'test://fixtures/signing');
  }
  const semantic=await s.recall({query:'报表导出失败后如何修正读取内存函数的编码并检查日志？'});assert.equal(semantic.items[0].id,m.memory_id);assert.ok(semantic.items[0].content.includes('输出编码'));assert.ok(semantic.items[0].excerpts.some(e=>e.start>1000));
  const expanded=await s.recall({ids:[m.memory_id],debug:true});assert.equal(expanded.items[0].content,content);assert.equal(expanded.diagnostics.full_body_records_read,1);
 }finally{s.close();}
});

test('many chunks cannot crowd out other memories, and overlapping hits merge with source offsets',async()=>{
 const {service:s,project}=await setup();s.encoder=fake;
 try{
  const [dominant]=seed(s,project,1,{body:'章'.repeat(3990),v:vector()});
  s.db.prepare('UPDATE memory_chunks SET end=60,text=? WHERE id=?').run('章'.repeat(60),dominant.chunk);
  s.storage.transaction(()=>{for(let i=1;i<100;i++){const c=s.db.prepare('INSERT INTO memory_chunks(memory_id,revision,start,end,tokens,text,profile_id) VALUES(?,1,?,?,10,?,?)').run(dominant.id,i*30,i*30+60,'章'.repeat(60),'deterministic-test');s.db.prepare('INSERT INTO memory_vec VALUES(?,?,?)').run(BigInt(c.lastInsertRowid),Buffer.from(vector().buffer),project);indexChunk(s.db,{id:Number(c.lastInsertRowid),memory_id:dominant.id,text:'章'.repeat(60)},'库存登记',[]);}});
  const rest=seed(s,project,24,{gold:true,v:vector(.9,Math.sqrt(.19))});
  const r=await s.recall({query:'语义任务',debug:true,limit:5},'vector');assert.equal(new Set(r.items.map(i=>i.id)).size,5);assert.ok(r.items.some(i=>rest.some(x=>x.id===i.id)));assert.ok(r.diagnostics.vector_queries>1);
  const item=r.items.find(i=>i.id===dominant.id);assert.equal(item.excerpts.length,1);assert.equal(item.excerpts[0].chunk_ids.length,2);assert.ok(item.content.length<3990);
 }finally{s.close();}
});

test('token/byte/character budgets preserve sources and report insufficient when headers do not fit',async()=>{
 const {service:s,project}=await setup();s.encoder=fake;
 try{
  const m=await publish(s,record(project,{content:'内容'.repeat(1900)}));
  let r=await s.recall({ids:[m.memory_id],token_budget:1000,debug:true});assert.ok(r.items.length===1);assert.ok(r.items[0].truncated);assert.ok(r.diagnostics.content_estimated_tokens<=1000);assert.ok(r.diagnostics.response_bytes<=32000);assert.ok(r.items[0].content.length<3800);assert.equal(r.items[0].sources[0].uri,'test://fixtures/signing');
  const huge=await publish(s,record(project,{sources:Array.from({length:12},(_,i)=>({source_type:'test',uri:'test://'+i+'a'.repeat(1700),locator:'original',revision_ref:'v1',checked_at:new Date().toISOString()}))}));
  r=await s.recall({ids:[huge.memory_id],token_budget:512,debug:true});assert.equal(r.items.length,0);assert.equal(r.evidence_status,'insufficient');assert.ok(r.warnings.includes('RESPONSE_BUDGET'));assert.ok(r.diagnostics.content_estimated_tokens<=512);
 }finally{s.close();}
});

test('updates, invalidation, reindex and forget remove old chunks, metadata and identifier indexes atomically',async()=>{
 const {service:s,project}=await setup();s.encoder=fake;
 try{
  const m=await publish(s,record(project,{content:'旧错误 ERR_OLD_PATH /tmp/old/path.log'})),child=await publish(s,record(project,{content:'子结论 ERR_CHILD_PATH',derived_from:[{memory_id:m.memory_id,revision:1}]}));
  await publish(s,record(project,{content:'新错误 ERR_NEW_PATH /tmp/new/path.log'}),{target_id:m.memory_id,expected_revision:1});
  assert.equal((await s.recall({query:'ERR_OLD_PATH',exact_only:true})).items.length,0);assert.equal((await s.recall({query:'ERR_CHILD_PATH',exact_only:true})).items.length,0);
  let r=await s.recall({query:'ERR_NEW_PATH',exact_only:true});assert.equal(r.items[0].revision,2);assert.ok(!r.items[0].content.includes('ERR_OLD_PATH'));
  await s.reindex();assert.equal((await s.recall({query:'ERR_NEW_PATH',exact_only:true})).items[0].revision,2);
  await s.forget({request_id:randomUUID(),memory_id:m.memory_id,expected_revision:2});
  for(const id of [m.memory_id,child.memory_id]){assert.equal(s.db.prepare('SELECT count(*) n FROM chunk_fts WHERE memory_id=?').get(id).n,0);assert.equal(s.db.prepare('SELECT count(*) n FROM chunk_identifiers WHERE memory_id=?').get(id).n,0);}
  assert.equal(s.db.prepare('SELECT count(*) n FROM memory_search WHERE memory_id=?').get(m.memory_id).n,0);assert.equal((await s.recall({query:'ERR_NEW_PATH',exact_only:true})).items.length,0);
  for(const key of ['search_mismatch','missing_chunk_fts','orphan_chunk_fts','orphan_identifiers'])assert.equal(s.check()[key].n,0);
 }finally{s.close();}
});

test('broken model explicitly degrades to indexed lexical/identifier retrieval',async()=>{
 const {service:s,project,root,config}=await setup();s.encoder=fake;const m=await publish(s,record(project,{content:'必须检查 ERR_BROKEN_MODEL 的构建日志。'}));
 const damaged=root+'/damaged-model';await mkdir(damaged);await writeFile(damaged+'/config.json','damaged model config');await writeFile(damaged+'/manifest.json',JSON.stringify({files:{'config.json':'0'.repeat(64)}}));
 const bad=new MemoryService({...config,model_dir:damaged});
 await assert.rejects(bad.encoder.profile(),{code:'MODEL_HASH_MISMATCH'});
 try{const r=await bad.recall({query:'ERR_BROKEN_MODEL',exact_only:true,debug:true});assert.equal(r.retrieval_mode,'lexical_degraded');assert.ok(r.warnings.includes('EMBEDDING_UNAVAILABLE'));assert.equal(r.items[0].id,m.memory_id);assert.equal(r.diagnostics.full_body_records_read,0);assert.equal(r.diagnostics.vector_queries,0);}finally{bad.close();s.close();}
});

// Build a genuine schema4 fixture by removing only schema5 derived objects.
function toSchema4(db){db.exec(`DROP TRIGGER search_insert;DROP TRIGGER search_update;DROP TRIGGER search_delete;DROP TRIGGER chunk_search_delete;DROP TABLE memory_search;DROP TABLE chunk_fts;DROP TABLE chunk_identifiers;
 CREATE TABLE old_vectors AS SELECT * FROM memory_vec;DROP TABLE memory_vec;CREATE VIRTUAL TABLE memory_vec USING vec0(chunk_id INTEGER PRIMARY KEY,embedding FLOAT[512],project_scope TEXT);INSERT INTO memory_vec SELECT * FROM old_vectors;DROP TABLE old_vectors;PRAGMA user_version=4;`);}
function signature(db){return {records:db.prepare('SELECT id,revision,body,content_hash FROM memories ORDER BY id').all(),vectors:db.prepare('SELECT chunk_id,hex(embedding) embedding FROM memory_vec ORDER BY chunk_id').all()};}
test('schema4 migration and backup rollback preserve IDs, revisions, canonical bodies and vector bytes; interrupted DDL rolls back',async()=>{
 const {service:s,project,root,config}=await setup();s.encoder=fake;seed(s,project,3,{gold:true,v:vector()});toSchema4(s.db);const before=signature(s.db);await backup(s.db,root+'/before.db');s.close();
 const code=`import {DatabaseSync} from 'node:sqlite';import * as vec from 'sqlite-vec';import {migrateSearch} from './dist/retrieval/indexes.js';const db=new DatabaseSync(process.argv[1],{allowExtension:true});vec.load(db);db.exec('BEGIN IMMEDIATE');migrateSearch(db);process.kill(process.pid,'SIGKILL');`;
 const interrupted=spawnSync(process.execPath,['--input-type=module','-e',code,config.database]);assert.equal(interrupted.signal,'SIGKILL');
 let db=new DatabaseSync(config.database,{allowExtension:true});vec.load(db);assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);assert.deepEqual(signature(db),before);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='memory_search'").get().n,0);db.close();
 const migrated=new MemoryService(config,fake);try{assert.equal(migrated.inspect().schema,5);assert.deepEqual(signature(migrated.db),before);assert.ok(migrated.db.prepare("SELECT sql FROM sqlite_master WHERE name='memory_vec'").get().sql.includes('distance_metric=cosine'));assert.ok(!Object.hasOwn(JSON.parse(migrated.db.prepare('SELECT metadata FROM memory_search LIMIT 1').get().metadata),'content'));assert.equal((await migrated.recall({query:'语义任务'},'vector')).items.length,3);}finally{migrated.close();}
 await copyFile(root+'/before.db',root+'/rolled-back.db');db=new DatabaseSync(root+'/rolled-back.db',{allowExtension:true});vec.load(db);try{assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);assert.deepEqual(signature(db),before);}finally{db.close();}
});
