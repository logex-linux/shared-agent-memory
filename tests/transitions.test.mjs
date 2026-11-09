import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { record, publish } from './helpers.mjs';
import { fake, setupFake } from './adaptive-helpers.mjs';
import { MemoryService } from '../dist/core/service.js';

const early='2026-01-01T00:00:00.000Z', cutoff='2026-02-01T00:00:00.000Z';
const oldRecord=(project,overrides={})=>record(project,{
  kind:'decision',title:'Synthetic channel limit',content:'We adopted the previous queue limit.',
  subject_id:'queue-A',context_key:'stable-channel',decision_state:'adopted',valid_time:{valid_from:early},...overrides
});
const ref=m=>({memory_id:m.memory_id,revision:m.revision});
const replacement=project=>oldRecord(project,{
  title:'Successor queue limit',content:'The queue limit has changed to the new value.',
  valid_time:{valid_from:cutoff,valid_to:'2090-01-01T00:00:00.000Z'}
});
async function plan(s,record,transition,targets,options={}) {
  return s.propose({request_id:randomUUID(),record,transition,
    ...(targets.length?{expected_refs:targets.map(ref)}:{}),...options});
}
const commitInput=p=>({request_id:randomUUID(),proposal_id:p.proposal_id,expected_revision:p.expected_revision});

test('supersession moves every predecessor atomically and keeps source revisions and dependency invalidation',async()=>{
  const {service:s,project}=await setupFake();
  try {
    const left=await publish(s,oldRecord(project));
    const right=await publish(s,oldRecord(project,{content:'The earlier review approved the old queue limit.'}));
    const derived=await publish(s,record(project,{derived_from:[ref(left)],content:'Derived from the first record.'}));
    const p=await plan(s,replacement(project),'supersede',[left,right]);
    const before=s.storage.generation(), input=commitInput(p);
    const result=await s.commit(input);
    assert.deepEqual(await s.commit(input),result);
    assert.equal(result.generation,before+1);
    assert.equal(result.relations.length,2);
    for(const e of result.relations){
      assert.equal(e.type,'supersedes');
      assert.deepEqual(e.from,ref(result));
      assert.equal(e.to.revision,2);
    }
    const rows=s.db.prepare('SELECT from_revision,to_revision,project_id,sources FROM memory_relations').all();
    assert(rows.every(e=>e.from_revision===1&&e.to_revision===2&&e.project_id===project&&JSON.parse(e.sources).length===1));
    const ids=[left.memory_id,right.memory_id,derived.memory_id,result.memory_id];
    assert.deepEqual((await s.recall({ids})).items.map(i=>i.id),[result.memory_id]);
    const past=await s.recall({ids,as_of:early,decision_state:'adopted'});
    assert.deepEqual(new Set(past.items.map(i=>i.id)),new Set([left.memory_id,right.memory_id]));
    assert(past.items.every(i=>i.revision===2&&i.lifecycle==='historical'&&i.valid_time.valid_to===cutoff));
    assert.deepEqual((await s.recall({ids,as_of:cutoff})).items.map(i=>i.id),[result.memory_id]);
    const old=(await s.recall({versions:[ref(left)]})).items[0];
    assert.equal(old.revision,1);
    assert.equal(old.valid_time.valid_to,undefined);
    assert.equal(s.check().relation_scope_errors.n,0);
    assert.equal(s.check().orphan_chunks.n,0);
  } finally {s.close();}
});

test('stale second predecessor and an interrupted multi-target transaction leave no partial successor',async()=>{
  const {service:s,project,config}=await setupFake();
  const racing=new MemoryService(config,fake);
  try {
    const left=await publish(s,oldRecord(project));
    const right=await publish(s,oldRecord(project));
    const p=await plan(s,replacement(project),'supersede',[left,right]);
    let resume, entered;
    const barrier=new Promise(resolve=>resume=resolve);
    const encoding=new Promise(resolve=>entered=resolve);
    s.encoder={...fake,chunks:async (...args)=>{entered();await barrier;return fake.chunks(...args);}};
    const committing=s.commit(commitInput(p));
    const rejected=assert.rejects(committing,{code:'VERSION_CONFLICT'});
    await encoding;
    const updated=await publish(racing,oldRecord(project,{content:'Concurrent correction.'}),{target_id:right.memory_id,expected_revision:1});
    resume();
    await rejected;
    assert.equal((await racing.recall({ids:[left.memory_id]})).items[0].revision,1);
    assert.equal(racing.db.prepare('SELECT count(*) n FROM memory_relations').get().n,0);
    const p2=await plan(racing,replacement(project),'supersede',[left,updated]);
    const generation=racing.storage.generation();
    const interrupted=new MemoryService(config,fake,point=>{if(point==='transition:predecessors')throw Error('injected interruption');});
    try {await assert.rejects(interrupted.commit(commitInput(p2)),/injected interruption/);}
    finally {interrupted.close();}
    assert.equal(racing.storage.generation(),generation);
    const after=await racing.recall({ids:[left.memory_id,right.memory_id]});
    assert.deepEqual(after.items.map(i=>i.revision),[1,2]);
    assert.equal(racing.db.prepare('SELECT count(*) n FROM memories').get().n,2);
    assert.equal(racing.db.prepare('SELECT count(*) n FROM memory_versions').get().n,3);
  } finally {racing.close();s.close();}
});

test('branches need distinct context, scoped relations need exact endpoints, and quarantine keeps historical evidence',async()=>{
  const {service:s,project,other}=await setupFake();
  try {
    const development=oldRecord(project,{valid_for:{environment:'development'},decision_state:'rejected'});
    const base=await publish(s,development);
    const differentSubject=oldRecord(project,{subject_id:'other-queue',valid_for:{environment:'production'}});
    await assert.rejects(plan(s,differentSubject,'branch',[base]),{code:'TRANSITION_SUBJECT_MISMATCH'});
    await assert.rejects(plan(s,development,'branch',[base]),{code:'TRANSITION_CONTEXT_NOT_DISTINCT'});
    await assert.rejects(plan(s,{...development,decision_state:'adopted'},'reinforce',[base]),{code:'TRANSITION_DECISION_CONFLICT'});
    await assert.rejects(plan(s,development,'reinforce',[base]),{code:'TRANSITION_SOURCE_REPEATED'});
    const next=await plan(s,{...development,valid_for:{environment:'production'},decision_state:'adopted'},'branch',[base]);
    const production=await s.commit(commitInput(next));
    assert.equal(production.relations[0].type,'context_variant');
    assert.equal(production.relations[0].to.revision,1);
    assert.deepEqual((await s.recall({ids:[base.memory_id,production.memory_id],context:{environment:'production'}})).items.map(i=>i.id),[production.memory_id]);
    const foreign=await publish(s,oldRecord(other));
    await assert.rejects(plan(s,development,'new',[foreign],{
      relations:[{type:'related_to',target_id:foreign.memory_id,sources:development.sources}]
    }),{code:'RELATION_SCOPE'});
    await assert.rejects(s.propose({
      request_id:randomUUID(),record:development,target_id:base.memory_id,expected_revision:1,
      expected_refs:[ref(base)],relations:[{type:'related_to',target_id:base.memory_id,sources:development.sources}]
    }),{code:'RELATION_SELF'});
    const isolatedDecision=await plan(s,development,'quarantine',[],{target_id:base.memory_id,expected_revision:1});
    const saved=await s.commit(commitInput(isolatedDecision));
    assert.equal(saved.revision,2);
    assert.deepEqual((await s.recall({ids:[base.memory_id]})).items,[]);
    const reviewed=(await s.recall({ids:[base.memory_id],include_history:true})).items[0];
    assert.equal(reviewed.lifecycle,'quarantined');
    assert.equal(reviewed.decision_state,'rejected');
    assert.equal(reviewed.applicability,'requires_check');
    await s.forget({request_id:randomUUID(),memory_id:base.memory_id,expected_revision:2});
    assert.equal(s.db.prepare('SELECT count(*) n FROM memory_relations').get().n,0);
    assert.equal((await s.recall({ids:[production.memory_id]})).items.length,1);
  } finally {s.close();}
});
