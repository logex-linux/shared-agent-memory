import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryService } from '../dist/core/service.js';
import { setupFake,fake } from './adaptive-helpers.mjs';
import { publish,record } from './helpers.mjs';

const ref=p=>({memory_id:p.memory_id,revision:p.revision});
const span=(p,end,role='support',start=0)=>({...ref(p),start,end,role});
const title='Keep the route table synchronized';
const input=(project,citations,mode='multi_source')=>({project_id:project,scope:'project',title,claim:title,
  kind:'procedure',evidence:{mode,citations}});
const draft=candidate=>({...candidate,author_client:'test',author_session:'consolidation'});

function fixtureRecord(project,content,uri,options={}) {
  const r=record(project,{title,content,subject_id:'route-table',context_key:'operation',...options});
  return {...r,sources:[{...r.sources[0],uri}]};
}

test('dry-run resolves original sources, collapses retellings and retains source offsets on publication',async()=>{
  const {service:s,project,root}=await setupFake();
  try {
    const aText='First verify the route table. Keep the route table synchronized.';
    const a=await publish(s,fixtureRecord(project,aText,'test://incident/first#paragraph'));
    const repeated=await publish(s,fixtureRecord(project,title,'test://retelling/notes',{derived_from:[ref(a)]}));
    const repeatedUri=await publish(s,fixtureRecord(project,title,'test://incident/first#summary'));
    const b=await publish(s,fixtureRecord(project,title,'test://independent/reproduction'));
    const start=aText.indexOf(title);
    const initial=input(project,[span(a,start+title.length,'support',start),span(repeated,title.length),span(repeatedUri,title.length)]);
    const generation=s.storage.generation();
    const before=s.db.prepare('SELECT count(*) n FROM events').get().n;
    const insufficient=s.consolidate(initial);
    assert.equal(insufficient.independent_support_groups,1);
    assert.equal(insufficient.candidate,null);
    const body={...initial,evidence:{...initial.evidence,citations:[...initial.evidence.citations,span(b,title.length)]}};
    const config=join(root,'consolidate.json'),request=join(root,'request.json');
    await writeFile(config,JSON.stringify(s.config));await writeFile(request,JSON.stringify(body));
    const report=JSON.parse(execFileSync(process.execPath,['dist/cli/main.js','consolidate','--dry-run','--config',config,'--input',request],{encoding:'utf8'}));
    assert.equal(report.status,'candidate');
    assert.equal(report.independent_support_groups,2);
    assert.equal(report.citations[0].excerpt,title);
    assert.equal(report.citations[0].start,start);
    assert.deepEqual(report.origins.map(e=>e.memory_id),[a,repeatedUri,b].map(e=>e.memory_id));
    assert.equal(s.storage.generation(),generation);
    assert.equal(s.db.prepare('SELECT count(*) n FROM events').get().n,before);
    await assert.rejects(s.propose({request_id:randomUUID(),record:{...draft(report.candidate),derived_from:[ref(a),ref(b)]}}),{code:'CONSOLIDATION_EVIDENCE_CHANGED'});
    const summary=await publish(s,draft(report.candidate));
    const current=(await s.recall({versions:[ref(summary)]})).items[0];
    assert.equal(current.verification.status,'unverified');
    assert.equal(current.verification.basis,'model_inference');
    assert.deepEqual(current.consolidation.citations,body.evidence.citations);
    assert.equal((await s.recall({ids:[a.memory_id]})).items[0].content,aText);
  } finally {s.close();}
});

test('conflicts produce quarantine candidates and a direct statement needs a literal user quote',async()=>{
  const {service:s,project,other}=await setupFake();
  try {
    const aRecord=fixtureRecord(project,title,'test://control/plan',{decision_state:'adopted'});
    const a=await publish(s,aRecord);
    const b=await publish(s,fixtureRecord(project,title,'test://counter/plan',{decision_state:'rejected'}),{
      expected_refs:[ref(a)],relations:[{target_id:a.memory_id,type:'contradicts',sources:aRecord.sources}]
    });
    const report=s.consolidate(input(project,[span(a,title.length),span(b,title.length,'counterexample')]));
    assert.equal(report.status,'conflict');
    assert.equal(report.contradictions.length,1);
    assert.equal(report.candidate.lifecycle,'quarantined');
    await assert.rejects(s.propose({request_id:randomUUID(),record:{...draft(report.candidate),lifecycle:'current'}}),{code:'CONSOLIDATION_CONFLICT'});
    const quarantined=await publish(s,draft(report.candidate));
    assert.deepEqual((await s.recall({ids:[quarantined.memory_id]})).items,[]);
    const u=await publish(s,{...aRecord,verification:{...aRecord.verification,basis:'user_confirmation'},
      sources:[{...aRecord.sources[0],source_type:'user'}]});
    const direct=input(project,[span(u,title.length)],'direct_statement');
    assert.equal(s.consolidate(direct).status,'direct_statement');
    assert.equal(s.consolidate({...direct,claim:'Different claim'}).status,'insufficient');
    assert.equal(s.consolidate(input(project,[span(u,title.length)])).status,'insufficient');
    const foreign=await publish(s,fixtureRecord(other,title,'test://foreign/source'));
    assert.throws(()=>s.consolidate(input(project,[span(a,title.length),span(foreign,title.length)])),{code:'CONSOLIDATION_SCOPE'});
  } finally {s.close();}
});

test('a parent revision changed during encoding prevents publication',async()=>{
  const {service:s,project}=await setupFake();
  const writer=new MemoryService(s.config,fake);
  try {
    const aRecord=fixtureRecord(project,title,'test://primary/check');
    const a=await publish(s,aRecord);
    const b=await publish(s,fixtureRecord(project,title,'test://independent/check'));
    const report=s.consolidate(input(project,[span(a,title.length),span(b,title.length)]));
    const proposed=await s.propose({request_id:randomUUID(),record:draft(report.candidate)});
    s.encoder={...fake,chunks:async(...args)=>{
      await publish(writer,{...aRecord,content:'Revised evidence.'},{target_id:a.memory_id,expected_revision:1});
      return fake.chunks(...args);
    }};
    await assert.rejects(s.commit({request_id:randomUUID(),proposal_id:proposed.proposal_id,expected_revision:0}),{code:'DEPENDENCY_STALE'});
    assert.equal(s.db.prepare("SELECT count(*) n FROM memories WHERE json_type(body,'$.consolidation') IS NOT NULL").get().n,0);
  } finally {writer.close();s.close();}
});
