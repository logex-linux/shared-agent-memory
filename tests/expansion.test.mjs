import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{MemoryService}from'../dist/core/service.js';import{setup,record,publish}from'./helpers.mjs';import{fake}from'./adaptive-helpers.mjs';
test('ID expansion exposes all budget-deferred IDs for bounded continuation without a query cursor',async()=>{
 const {service:s,project}=await setup();s.encoder=fake;
 try{
  const ids=[];for(let i=0;i<6;i++)ids.push((await publish(s,record(project,{title:'Expansion fixture '+i,content:'Evidence '+i+': '+'x'.repeat(1400)}))).memory_id);
  const seen=new Set();let pending=ids,pages=0;
  while(pending.length){const r=await s.recall({ids:pending,max_bytes:5500,debug:true});pages++;assert.ok(r.items.length);assert.equal(r.has_more,false);assert.equal(r.next_cursor,null);assert.ok(Buffer.byteLength(JSON.stringify(r))<=5500);assert.ok(r.diagnostics.full_body_records_read<=r.items.length+1);for(const x of r.items){assert.ok(!seen.has(x.id));assert.ok(x.sources.length);assert.equal(x.revision,1);seen.add(x.id);}pending=r.remaining_ids??[];if(pending.length){assert.ok(r.warnings.includes('PARTIAL_ID_EXPANSION'));assert.equal(r.retrieval.stop_reason,'page_budget');}}
  assert.ok(pages>1);assert.deepEqual(seen,new Set(ids));
 }finally{s.close();}
});
test('ID continuation respects item limits and never lists unauthorized, unknown or expired IDs',async()=>{
 const {service:s,project,other,config}=await setup();s.encoder=fake;
 try{
  const own=[];for(let i=0;i<2;i++)own.push((await publish(s,record(project,{title:'Own '+i}))).memory_id);
  const foreign=(await publish(s,record(other))).memory_id,global=(await publish(s,record(null))).memory_id,expired=(await publish(s,record(project,{valid_for:{expires_at:'2020-01-01T00:00:00.000Z'}}))).memory_id;
  const reader=new MemoryService({...config,allowed_projects:[project],allow_global:false,operations:['recall']},fake);
  try{const r=await reader.recall({ids:[...own,foreign,global,expired,randomUUID()],limit:1});assert.deepEqual(r.items.map(x=>x.id),[own[0]]);assert.deepEqual(r.remaining_ids,[own[1]]);const next=await reader.recall({ids:r.remaining_ids});assert.equal(next.items[0].id,own[1]);assert.equal(next.remaining_ids,undefined);}finally{reader.close();}
 }finally{s.close();}
});
test('a metadata-blocked ID can be expanded with a larger budget without losing its continuation',async()=>{
 const {service:s,project}=await setup();s.encoder=fake;
 try{
  const m=await publish(s,record(project,{sources:[{source_type:'test',uri:'test://'+'a'.repeat(1800),locator:'fixture',revision_ref:'1',checked_at:'2025-01-01T00:00:00.000Z'}]}));
  const r=await s.recall({ids:[m.memory_id],max_bytes:2048,token_budget:512});assert.equal(r.items.length,0);assert.deepEqual(r.remaining_ids,[m.memory_id]);assert.deepEqual(r.blocked_ids,[m.memory_id]);assert.ok(Buffer.byteLength(JSON.stringify(r))<=2048);
  const next=await s.recall({ids:r.remaining_ids});assert.equal(next.items[0].id,m.memory_id);assert.equal(next.remaining_ids,undefined);assert.equal(next.items[0].sources[0].uri.length,1807);
 }finally{s.close();}
});
