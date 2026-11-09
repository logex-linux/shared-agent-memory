import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryService } from '../dist/core/service.js';
import { setupFake, fake, vector } from './adaptive-helpers.mjs';
import { record, publish } from './helpers.mjs';

const request={query:'thermal pump outage restart procedure',mode:'focused',view:'evidence',limit:20,debug:true};
const evidence=(project,title,content,overrides={})=>record(project,{
  kind:'fact',title,content,tags:[],sources:[{source_type:'test',uri:'test://graph/'+encodeURIComponent(title),
    locator:'synthetic paragraph',revision_ref:'fixture',checked_at:'2026-01-01T00:00:00.000Z'}],...overrides
});
const step=(s,from,to,overrides={})=>{
  const source=s.db.prepare('SELECT project_id,scope FROM memories WHERE id=?').get(from.memory_id);
  const id=randomUUID();
  const sources=evidence(source.project_id,'relation '+id,'').sources;
  s.db.prepare('INSERT INTO memory_relations VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
    id,1,from.memory_id,from.revision,to.memory_id,to.revision,overrides.type??'related_to',
    overrides.project??source.project_id,source.scope,overrides.sources??JSON.stringify(sources),'2026-01-01T00:00:00.000Z');
  return id;
};
function fixtureEncoder(title) {
  const cosine=title.startsWith('Incident ')?1:title.startsWith('Background ')?0.8:title==='Correct follow-up runbook'?0.59:0;
  return vector(cosine,Math.sqrt(1-cosine*cosine));
}
async function graphFixture(config={}) {
  const f=await setupFake({graph_enabled:true,...config});
  const s=f.service;
  s.encoder={...fake,chunks:async (title,text)=>[{text,start:0,end:text.length,tokens:18,vector:fixtureEncoder(title)}]};
  const seed=await publish(s,evidence(f.project,'Incident thermal pump outage restart procedure','Thermal pump outage restart procedure began after a failed flow check.'));
  const relay=await publish(s,evidence(f.project,'Relay observation','The intake gauge was damaged in a separate laboratory event.'));
  const answer=await publish(s,evidence(f.project,'Correct follow-up runbook','After the thermal pump outage, reseat the bronze isolator before starting.'));
  for(let i=0;i<12;i++)
    await publish(s,evidence(f.project,'Background restart note '+i,'Thermal pump outage restart procedure background discussion '+i+'.'));
  return {...f,seed,relay,answer};
}

test('an eligible two-hop path explains independent evidence, with cycles and exact-only isolation',async()=>{
  const {service:s,seed,relay,answer}=await graphFixture();
  try {
    const cold=await s.recall({...request,graph:true});
    assert.deepEqual(cold.items,(await s.recall(request)).items);
    assert.equal(cold.retrieval.graph.frontier,0);
    const first=step(s,seed,relay);
    const second=step(s,relay,answer);
    step(s,relay,seed);
    step(s,seed,answer,{type:'contradicts'});
    const r=await s.recall({...request,graph:true});
    const found=r.items.find(item=>item.id===answer.memory_id);
    assert.equal(found?.content.includes('bronze isolator'),true);
    assert.deepEqual(found.graph_path.steps.map(e=>e.id),[first,second]);
    assert.deepEqual(found.graph_path.seed,{memory_id:seed.memory_id,revision:1});
    assert.ok(found.graph_path.steps.every(e=>e.sources.length===1&&e.direction==='outgoing'));
    assert.equal(found.verification.status,'unverified');
    assert.equal(r.diagnostics.full_body_records_read,0);
    assert.ok(r.diagnostics.graph_rows_examined<=128);
    const exact=await s.recall({query:'ERR_PUMP_MISSING',graph:true,exact_only:true});
    assert.deepEqual(exact.items,[]);
    assert.ok(exact.warnings.includes('GRAPH_EXACT_ONLY'));
  } finally {s.close();}
});

test('current endpoint scope, context and dependencies prevent invisible graph bridges',async()=>{
  const {service:s,project,other,seed,answer}=await graphFixture({all_projects:true});
  try {
    const foreign=await publish(s,evidence(other,'Foreign relay','Relay named in a foreign project.'));
    step(s,seed,foreign);
    step(s,foreign,answer);
    const staging=await publish(s,evidence(project,'Staging relay','In staging the intake gauge was damaged.',
      {valid_for:{environment:'staging'}}));
    step(s,seed,staging);
    step(s,staging,answer);
    const inaccessibleParent=await publish(s,evidence(project,'Prod dependency','Original production calibration.',
      {valid_for:{environment:'production'}}));
    const dependent=await publish(s,evidence(project,'Unqualified relay','It was an intake gauge.',
      {derived_from:[{memory_id:inaccessibleParent.memory_id,revision:1}]}));
    step(s,seed,dependent);
    step(s,dependent,answer);
    const r=await s.recall({...request,graph:true,context:{environment:'development'}});
    assert.ok(r.items.every(i=>!i.graph_path));
    assert.equal(r.diagnostics.graph_candidates_admitted,0);
  } finally {s.close();}
});

test('stale edges, deletion, corruption and pure graph changes have explicit safe behavior',async()=>{
  const {service:s,project,seed,relay,answer}=await graphFixture();
  try {
    const edge=step(s,seed,relay);
    step(s,relay,answer);
    const on=await s.recall({...request,graph:true,limit:1});
    const off=await s.recall({...request,limit:1});
    assert.ok(on.next_cursor&&off.next_cursor);
    const encoder=s.encoder;
    let profiles=0;
    s.encoder={...encoder,profile:async()=>{profiles++;return {id:'changed-profile',manifest:{}};}};
    await assert.rejects(s.recall({cursor:on.next_cursor}),{code:'CURSOR_GRAPH_CHANGED'});
    assert.equal((await s.recall({cursor:off.next_cursor})).items.length,1);
    assert.equal(profiles,1);
    s.encoder=encoder;
    s.db.exec("UPDATE meta SET value=value+1 WHERE key='graph_epoch'");
    await assert.rejects(s.recall({cursor:on.next_cursor}),{code:'CURSOR_GRAPH_CHANGED'});
    assert.equal((await s.recall({cursor:off.next_cursor})).items.length,1);
    s.db.prepare('UPDATE memory_relations SET sources=? WHERE id=?').run('{',edge);
    const degraded=await s.recall({...request,graph:true});
    assert.equal(degraded.retrieval.graph.state,'degraded');
    assert.ok(degraded.warnings.includes('GRAPH_UNAVAILABLE'));
    assert.deepEqual(degraded.items,(await s.recall(request)).items);
    s.db.prepare('UPDATE memory_relations SET sources=? WHERE id=?').run(JSON.stringify(evidence(project,'repaired','').sources),edge);
    const updated=await publish(s,evidence(project,'Relay observation','A corrected relay report.'),{target_id:relay.memory_id,expected_revision:1});
    const stale=await s.recall({...request,graph:true});
    assert.ok(stale.warnings.includes('GRAPH_STALE'));
    assert.ok(stale.items.every(i=>!i.graph_path));
    await s.forget({request_id:randomUUID(),memory_id:relay.memory_id,expected_revision:updated.revision});
    assert.equal(s.db.prepare('SELECT count(*) n FROM memory_relations').get().n,0);
    const next=await s.recall({...request,graph:true});
    assert.ok(next.items.every(i=>i.id!==relay.memory_id&&!i.graph_path));
  } finally {s.close();}
});

function worker(config,input) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['tests/concurrency-worker.mjs',config,input]);
    let output='',error='';
    child.stdout.on('data',b=>output+=b);
    child.stderr.on('data',b=>error+=b);
    child.once('error',reject);
    child.once('exit',code=>{
      if(code!==0){reject(Error(error));return;}
      try{resolve(JSON.parse(output));}catch(e){reject(e);}
    });
  });
}

test('high-degree graph persists a bounded frontier and concurrent readers replay one next page',async()=>{
  const {service:s,root,project}=await setupFake({graph_enabled:true,page_candidate_budget:32});
  try {
    s.encoder={...fake,chunks:async (title,text)=>[{text,start:0,end:text.length,tokens:18,
      vector:title.startsWith('Thermal pump outage ')?vector(0.8,0.6):vector()}]};
    const anchor=await publish(s,evidence(project,'thermal pump outage restart procedure','Thermal pump outage restart procedure is the primary record.'));
    for(let i=0;i<37;i++) {
      const neighbor=await publish(s,evidence(project,'Thermal pump outage '+i,'Thermal pump outage restart procedure note '+i+'.'));
      step(s,anchor,neighbor);
    }
    const query={...request,mode:'broad',limit:4,graph:true};
    const first=await s.recall(query);
    assert.ok(first.next_cursor);
    assert.ok(first.retrieval.graph.frontier>0);
    const path=join(root,'graph-reader.json'),input=join(root,'graph-cursor.json');
    await writeFile(path,JSON.stringify(s.config));
    await writeFile(input,JSON.stringify({cursor:first.next_cursor,debug:true}));
    const [a,b]=await Promise.all([worker(path,input),worker(path,input)]);
    assert.deepEqual(a.items,b.items);
    assert.deepEqual(a.retrieval,b.retrieval);
    assert.ok(a.diagnostics.graph_rows_examined<=32);
    const seen=new Set(first.items.map(i=>i.id));
    let r=a,pages=0;
    for(;;) {
      for(const item of r.items){assert.ok(!seen.has(item.id));seen.add(item.id);}
      assert.ok(r.diagnostics.graph_rows_examined+r.diagnostics.vector_rows_returned<=32);
      assert.equal(r.diagnostics.full_body_records_read,0);
      if(!r.has_more)break;
      assert.ok(pages++<50);
      r=await s.recall({cursor:r.next_cursor,debug:true});
    }
    assert.ok(r.warnings.includes('GRAPH_NEIGHBOR_LIMIT'));
    assert.equal(r.retrieval.stop_reason,'graph_limit');
    assert.equal(r.retrieval.more_unexamined,true);
    assert.equal(seen.size,38);
    const replayed=await s.recall({cursor:first.next_cursor,debug:true});
    assert.deepEqual({...replayed,diagnostics:null},{...a,diagnostics:null});
  } finally {s.close();}
});

test('learned graph admits independently relevant evidence and expires weights without deleting facts',async()=>{
  const {service:s,seed,answer}=await graphFixture({all_projects:true,learned_graph_enabled:true,
    response_token_budget:12000,feedback_policy:'trusted_outcomes',operations:['recall','propose','commit','manage','feedback']});
  const linked=(result)=>result.items.find(item=>item.id===answer.memory_id)?.graph_path?.steps[0];
  try {
    const read=await s.recall(request);
    const used=[seed,answer].map(ref=>({memory_id:ref.memory_id,revision:ref.revision}));
    assert.ok(used.every(ref=>read.items.some(i=>i.id===ref.memory_id)));
    const page=await s.recall({...request,graph:true,limit:1});
    const off=await s.recall({...request,limit:1});
    assert.ok(page.next_cursor&&off.next_cursor);
    const submit=()=>s.feedback({request_id:randomUUID(),task_id:randomUUID(),page_receipt:read.feedback_receipt,
      used,outcome:'useful',basis:'test_result',evidence_ref:'test://consolidated/independent-evidence'});
    await submit();
    assert.equal(linked(await s.recall({...request,graph:true})),undefined);
    assert.equal(s.projectFeedback().changed_edges,1);
    await assert.rejects(s.recall({cursor:page.next_cursor}),{code:'CURSOR_GRAPH_CHANGED'});
    assert.ok((await s.recall({cursor:off.next_cursor})).items.length);
    const trained=await s.recall({...request,graph:true});
    const association=linked(trained);
    assert.equal(association.type,'learned_association');
    assert.equal(association.association_policy,'scoped-outcomes-v1');
    assert.ok(association.learned_weight>=0.19);
    assert.equal(association.sources.length,2);
    assert.equal(trained.items.find(i=>i.id===answer.memory_id).verification.status,'unverified');
    s.config.learned_graph_enabled=false;
    assert.equal(linked(await s.recall({...request,graph:true})),undefined);
    s.config.learned_graph_enabled=true;
    assert.equal((await s.recall({...request,graph:true,as_of:'2026-01-01T00:00:00.000Z'})).retrieval.graph.learned,undefined);
    s.db.prepare('UPDATE association_edges SET updated_ms=?').run(Date.now()-300*86400000);
    assert.equal(linked(await s.recall({...request,graph:true})),undefined);
    assert.equal((await s.recall({ids:[answer.memory_id]})).items[0].verification.status,'unverified');
  } finally {s.close();}
});
