import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {setup} from './helpers.mjs';import {fake,seed} from './adaptive-helpers.mjs';import {QueryState} from '../dist/retrieval/state.js';import {prepared} from '../dist/storage/statements.js';
test('per-connection statement reuse has bounded capacity and never shares bindings between databases',()=>{
 const a=new DatabaseSync(':memory:'),b=new DatabaseSync(':memory:');try{const ca=prepared(a),cb=prepared(b),first=ca.prepare('SELECT ? value');assert.equal(ca.prepare('SELECT ? value'),first);assert.notEqual(cb.prepare('SELECT ? value'),first);assert.equal(first.get(1).value,1);assert.equal(first.get(2).value,2);for(let i=0;i<100;i++)ca.prepare('SELECT '+i+' value');assert.notEqual(ca.prepare('SELECT ? value'),first);}finally{a.close();b.close();}
});
test('warm retrieval reuses sidecar; skips no-op cleanup writer and only materializes each hit chunk once per request',async()=>{
 const {service:s,project}=await setup();s.encoder=fake;seed(s,[project],80);
 try{const state=QueryState.open(s.db,s.config),r=await s.recall({query:'设计偏好',mode:'focused',view:'evidence',limit:4,debug:true});assert.equal(QueryState.open(s.db,s.config),state);assert.equal(r.diagnostics.state_lock.transactions,1);assert.equal(r.diagnostics.chunk_text_rows_read,0);assert.ok(r.diagnostics.ranking_chunk_rows_read>0);assert.equal(r.diagnostics.full_body_records_read,0);assert.ok(r.diagnostics.stages_ms.total>0);const next=await s.recall({cursor:r.next_cursor,debug:true});assert.equal(next.diagnostics.query_embeddings,0);assert.ok(next.items.every(i=>!r.items.some(j=>j.id===i.id)));}finally{s.close();}
});
test('pooled state recovers after rolled-back page quota error and commits expiry cleanup independently',async()=>{
 const {service:s,project}=await setup({cache_query_max_bytes:16384,cache_cleanup_rows:8});s.encoder=fake;seed(s,[project],80);
 try{await assert.rejects(s.recall({query:'设计偏好',mode:'broad'}),{code:'QUERY_CACHE_CAPACITY'});assert.equal(s.cache().active_queries,0);s.config.cache_query_max_bytes=8388608;const r=await s.recall({query:'设计偏好',mode:'broad',limit:2});assert.equal(r.items.length,2);const c=new DatabaseSync(s.config.database+'.retrieval.db');c.exec('UPDATE queries SET expires=0');c.close();await assert.rejects(s.recall({cursor:r.next_cursor}),{code:'CURSOR_EXPIRED'});assert.ok(s.cache().stats.cleanup_rows>0);assert.equal(s.check().integrity[0].integrity_check,'ok');}finally{s.close();}
});
test('pooled connection closes with its owner and cannot silently reuse a released native handle',async()=>{
 const {service:s,project}=await setup();s.encoder=fake;seed(s,[project],2);await s.recall({query:'设计偏好'});const state=QueryState.open(s.db,s.config);s.close();assert.throws(()=>state.db.prepare('SELECT 1').get(),/closed|not open/i);
});
test('disk quota failure is explicit and preserves the canonical database with a reusable pooled connection',async()=>{
 const {service:s,project}=await setup({cache_disk_max_bytes:1048576,page_candidate_budget:64});s.encoder=fake;seed(s,[project],200);const gen=s.storage.generation();let capacity=false;
 try{for(let i=0;i<80;i++){try{await s.recall({query:'设计偏好',mode:'broad',limit:7});}catch(e){assert.equal(e.code,'QUERY_CACHE_DISK_CAPACITY');capacity=true;break;}}assert.ok(capacity);assert.equal(s.storage.generation(),gen);assert.equal(s.db.prepare('SELECT count(*) n FROM memories').get().n,200);assert.equal(s.check().integrity[0].integrity_check,'ok');}finally{s.close();}
});
