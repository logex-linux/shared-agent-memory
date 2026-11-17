import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {backup} from 'node:sqlite';
import {MemoryService} from '../dist/core/service.js';
import {currentMaintenance} from '../dist/memory/recovery.js';
import {hash} from '../dist/core/contracts.js';
import {fake,setupFake} from './adaptive-helpers.mjs';
import {forget,publish,record} from './helpers.mjs';

const ref=result=>({memory_id:result.memory_id,revision:result.revision});
const id=randomUUID;
const oldTime='2025-07-01T00:00:00.000Z';
const effective='2025-09-01T00:00:00.000Z';
const propose=(s,record,fields={})=>s.propose({request_id:id(),record,...fields});
const commit=(s,proposal)=>s.commit({request_id:id(),proposal_id:proposal.proposal_id,expected_revision:proposal.expected_revision});
const query={query:'synthetic unified launch policy',mode:'broad',limit:1,subject_id:'launch.mode',context_key:'stable'};
const source=importKey=>({source_type:'code',uri:'test://fixture/'+importKey,locator:'isolated source',revision_ref:importKey,checked_at:oldTime});
const rule=(project,overrides={})=>record(project,{title:'Synthetic unified launch policy',
  content:'The synthetic unified launch policy runs in mode A.',subject_id:'launch.mode',context_key:'stable',
  kind:'preference',decision_state:'adopted',sources:[source('policy-v1')],...overrides});
const sameFixture=(project,label)=>record(project,{kind:'fact',title:'Synthetic lifecycle '+label,content:'Synthetic lifecycle '+label,sources:[source(label)]});
const noBody=(s,id)=>assert.equal(s.db.prepare('SELECT body FROM proposals WHERE id=?').get(id).body,null);
const verify=s=>{
  const checks=s.check();
  assert.equal(checks.integrity[0].integrity_check,'ok');
  for(const [name,row] of Object.entries(checks))if('n' in row)assert.equal(row.n,0,name);
};

test('task exclusions and subject filters apply to query, exact reads and resumed candidate selection',async()=>{
  const {service:s,project}=await setupFake();
  try {
    const rules=[];
    for(const environment of ['one','two','three','four'])rules.push(await publish(s,rule(project,{
      content:'Synthetic unified launch policy '+environment,valid_for:{environment}})));
    const ids=rules.map(r=>r.memory_id),exclude_ids=[ids[0],ids[2]];
    const first=await s.recall({...query,exclude_ids});
    assert.ok(first.has_more);
    await assert.rejects(s.recall({cursor:first.next_cursor,exclude_ids:[ids[1]]}),{code:'CURSOR_QUERY_MISMATCH'});
    await assert.rejects(s.recall({cursor:first.next_cursor,context_key:'other'}),{code:'CURSOR_QUERY_MISMATCH'});
    const next=await s.recall({cursor:first.next_cursor,exclude_ids:[...exclude_ids].reverse()});
    assert.deepEqual(new Set([...first.items,...next.items].map(r=>r.id)),new Set([ids[1],ids[3]]));
    assert.deepEqual((await s.recall({ids,exclude_ids,subject_id:'launch.mode'})).items.map(r=>r.id),[ids[1],ids[3]]);
    assert.deepEqual((await s.recall({versions:rules.map(ref),exclude_ids,context_key:'other'})).items,[]);
    assert.deepEqual((await s.recall({versions:rules.map(ref),exclude_ids,context_key:'stable'})).items.map(r=>r.id),[ids[1],ids[3]]);
    assert.equal((await s.recall({ids:[ids[0]]})).items[0].revision,1);
  } finally {s.close();}
});

test('one adopted rule wins concurrent commits, with independent environments and durable duplicate checks',async()=>{
  const {service:s,config,project,other}=await setupFake();
  const rival=new MemoryService(config,fake);
  try {
    await assert.rejects(propose(s,rule(project,{subject_id:undefined})),{code:'RULE_IDENTITY_REQUIRED'});
    await assert.rejects(propose(s,rule(project,{valid_time:{valid_from:'2090-01-01T00:00:00.000Z'}})),{code:'RULE_NOT_YET_EFFECTIVE'});
    const a=await propose(s,rule(project)), b=await propose(rival,rule(project,{content:'Mode B is active.'}));
    const outcomes=await Promise.allSettled([commit(s,a),commit(rival,b)]);
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(outcomes.find(r=>r.status==='rejected').reason.code,'CURRENT_RULE_CONFLICT');
    await publish(s,rule(other));
    await publish(s,rule(project,{valid_for:{environment:'staging'}}));
    await publish(s,rule(project,{decision_state:'proposed',valid_time:{valid_from:'2090-01-01T00:00:00.000Z'}}));
    const original=sameFixture(project,'distinct');
    const fact=await publish(s,original);
    await assert.rejects(propose(s,{...original,content:original.content+'\n',author_session:'retry',
      sources:[{...original.sources[0],checked_at:effective}]}),{code:'DUPLICATE_RECORD'});
    await assert.rejects(propose(s,original,{target_id:fact.memory_id,expected_revision:1}),{code:'NO_CHANGES'});
    await publish(s,{...original,sources:[source('independent-evidence')]});
  } finally {rival.close();s.close();}
});

test('explicit legacy identity supersedes into the existing successor and can replay from its prior revision',async()=>{
  const {service:s,config,root,project}=await setupFake({all_projects:true});
  try {
    const first={...sameFixture(project,'temporary directory cleanup originally absent'),valid_for:{commit:'version-old'},sources:[source('version-old')]};
    const fixed={...sameFixture(project,'temporary directory cleanup now runs'),sources:[source('version-fixed')]};
    const prior=await publish(s,first),successor=await publish(s,fixed);
    const database=join(root,'recovery.db');
    await backup(s.db,database);
    const data={...fixed,subject_id:'sam.temp.cleanup',context_key:'dev-tests',valid_time:{valid_from:effective}};
    const plan={transition:'supersede',target_id:successor.memory_id,expected_revision:1,expected_refs:[ref(prior)],
      version_evolution:{from_commit:'version-old',to_commit:'version-fixed',adopt_legacy_identity:true,sources:[first.sources[0],fixed.sources[0]]}};
    await assert.rejects(propose(s,data,{...plan,version_evolution:undefined}),{code:'TRANSITION_SUBJECT_MISMATCH'});
    const p=await propose(s,data,plan);
    const result=await commit(s,p);
    assert.equal(result.memory_id,successor.memory_id);
    assert.equal(result.revision,2);
    assert.equal(s.db.prepare('SELECT count(*) n FROM memories').get().n,2);
    assert.deepEqual((await s.recall({ids:[prior.memory_id,successor.memory_id]})).items.map(i=>i.id),[successor.memory_id]);
    const old=(await s.recall({ids:[prior.memory_id],as_of:oldTime,context:{commit:'version-old'}})).items[0];
    assert.equal(old.subject_id,'sam.temp.cleanup');
    assert.equal(old.valid_time.valid_to,effective);
    const staging=join(root,'staged-supersede');
    const restored=new MemoryService({...config,database,maintenance_state:staging},fake,undefined,true);
    try {
      await assert.rejects(restored.recall({ids:[prior.memory_id]}),{code:'RECOVERY_RECONCILIATION_REQUIRED'});
      await restored.recover(currentMaintenance(s.db),[]);
      for(const table of ['memories','memory_relations','memory_search']) {
        assert.deepEqual(restored.db.prepare('SELECT * FROM '+table+' ORDER BY 1').all(),
          s.db.prepare('SELECT * FROM '+table+' ORDER BY 1').all());
      }
      verify(restored);
    } finally {restored.close();}
  } finally {s.close();}
});

test('alias replacement detects collisions and grouped reassign preserves original evidence under current authority',async()=>{
  const {service:s,config,root,project,other}=await setupFake({all_projects:true});
  try {
    const work=join(root,'active-checkout');await mkdir(work);
    const input={request_id:id(),project_id:project,aliases:[work]};
    await assert.rejects(s.projectAliases({...input,aliases:[join(root,'other')]}),{code:'ALIAS_CONFLICT'});
    const projectPlan=await s.projectAliases(input);
    await s.projectAliases({...input,plan_hash:projectPlan.plan_hash},true);
    assert.equal((await s.resolveProject(work)).project_id,project);
    assert.equal((await s.resolveProject(root)).status,'unregistered');
    const narrow=new MemoryService({...config,allowed_projects:[project],all_projects:false,allow_global:false,
      require_work_directory:true,connection_id:'old-scope',operations:['recall','propose','commit']},fake);
    try {
      const origin=sameFixture(project,'wrong project');
      await assert.rejects(propose(narrow,origin),{code:'WORK_DIRECTORY_REQUIRED'});
      await assert.rejects(propose(narrow,origin,{work_directory:root}),{code:'PROJECT_UNRESOLVED'});
      const proposal=await propose(narrow,origin,{work_directory:work});
      const receipt={request_id:id(),proposal_id:proposal.proposal_id,expected_revision:0};
      const a=await narrow.commit(receipt);
      const b=await publish(s,{...sameFixture(project,'dependent'),derived_from:[ref(a)]},{
        expected_refs:[ref(a)],relations:[{type:'related_to',target_id:a.memory_id,sources:origin.sources}]});
      const pending=await propose(narrow,{...origin,content:'edit pending in old workspace'},
        {target_id:a.memory_id,expected_revision:1,work_directory:work});
      const target={scope:'project',project_id:other};
      const one={request_id:id(),records:[ref(a)],destination:target,reason:'Correct project from dated fixture source'};
      const preview=await s.reassign(one);
      assert.ok(preview.blocked.length);
      await assert.rejects(s.reassign({...one,plan_hash:preview.plan_hash},true),{code:'REASSIGN_CROSS_SCOPE_REFERENCE'});
      const exported=await s.export(project,false,'versioned');
      const group={...one,request_id:id(),records:[ref(a),ref(b)]};
      const oldVersion=s.db.prepare('SELECT body,content_hash FROM memory_version_bodies WHERE memory_id=? AND revision=1').get(a.memory_id);
      const validPlan=await s.reassign(group);
      const moved=await s.reassign({...group,plan_hash:validPlan.plan_hash},true);
      assert.equal(moved.records.length,2);
      assert.deepEqual(await narrow.recall({versions:[ref(a)]}).then(r=>r.items),[]);
      await assert.rejects(narrow.commit(receipt),{code:'SCOPE_DENIED'});
      await assert.rejects(commit(narrow,pending),{code:'PROPOSAL_NOT_PENDING'});
      await assert.rejects(readFile(exported.path),{code:'ENOENT'});
      const original=(await s.recall({versions:[ref(a)],project_id:other})).items[0];
      assert.equal(original.project_id,other);
      assert.equal(original.recorded_ownership.project_id,project);
      assert.deepEqual(s.db.prepare('SELECT body,content_hash FROM memory_version_bodies WHERE memory_id=? AND revision=1').get(a.memory_id),oldVersion);
      assert.equal(s.db.prepare('SELECT project_id FROM memory_relations').get().project_id,other);
      verify(s);
    } finally {narrow.close();}
  } finally {s.close();}
});

test('forget preview binds the entire accessible closure and retries managed file cleanup',async()=>{
  const {service:s,config,project,other}=await setupFake();
  try {
    const origin=await publish(s,sameFixture(null,'global cause'));
    const a=await publish(s,{...sameFixture(project,'first derived'),derived_from:[ref(origin)]});
    const restricted=new MemoryService({...config,allowed_projects:[project],connection_id:'limited-scope'},fake);
    const target={memory_id:origin.memory_id,expected_revision:1};
    try {
      await assert.rejects(s.forget({...target,request_id:id()}),{code:'FORGET_PREVIEW_REQUIRED'});
      const before=s.forgetPreview(target);
      assert.equal(before.records.length,2);
      const b=await publish(s,{...sameFixture(other,'next derived'),derived_from:[ref(origin)]});
      assert.throws(()=>restricted.forgetPreview(target),{code:'SCOPE_DENIED'});
      await assert.rejects(s.forget({...target,request_id:id(),plan_hash:before.plan_hash}),{code:'PLAN_STALE'});
      const exportFile=await s.export(project,true,'versioned');
      await rm(exportFile.path);await mkdir(exportFile.path);
      const plan=s.forgetPreview(target);
      assert.equal(plan.records.length,3);
      assert.equal(plan.dependencies.length,2);
      assert.equal(plan.indexes.fts,3);
      const input={...target,request_id:id(),plan_hash:plan.plan_hash};
      await assert.rejects(restricted.forget(input),{code:'SCOPE_DENIED'});
      const erased=await s.forget(input);
      assert.equal(erased.cleanup,'pending');
      assert.equal(erased.maintenance.managed_exports_pending,1);
      assert.deepEqual((await s.recall({ids:[a.memory_id,b.memory_id,origin.memory_id]})).items,[]);
      await rm(exportFile.path,{recursive:true});
      const retried=await s.forget(input);
      assert.equal(retried.generation,erased.generation);
      assert.equal(retried.cleanup,'complete');
      verify(s);
    } finally {restricted.close();}
  } finally {s.close();}
});

test('a versioned export of a relocated derivation retains trusted historical references on restore',async()=>{
  const src=await setupFake({all_projects:true}),dst=await setupFake({all_projects:true});
  const {service:s,project,other,root}=src;
  try {
    const evidence={...sameFixture(project,'explicit user observation'),sources:[{...source('direct'),source_type:'user'}],
      verification:{method:'direct user statement',summary:'Synthetic direct evidence',basis:'user_confirmation'}};
    const parent=await publish(s,evidence);
    const statement=s.consolidate({project_id:project,scope:'project',title:'Consolidated fixture',claim:evidence.content,
      kind:'procedure',evidence:{mode:'direct_statement',citations:[{...ref(parent),start:0,end:evidence.content.length}]}});
    const child=await publish(s,{...statement.candidate,author_client:'test',author_session:'reassign-archive'});
    const move={request_id:id(),records:[ref(parent),ref(child)],destination:{project_id:other,scope:'project'},reason:'Grouped fixture relocation'};
    await s.reassign({...move,plan_hash:(await s.reassign(move)).plan_hash},true);
    await assert.rejects(propose(s,{...sameFixture(other,'new record with retired evidence'),derived_from:[ref(parent)]}),{code:'DEPENDENCY_STALE'});
    const archive=JSON.parse(await readFile((await s.export(other,false,'versioned')).path,'utf8'));
    await dst.service.project(other,'reassigned fixtures',join(root,'other'));
    await dst.service.applyRevocations([]);
    await assert.rejects(dst.service.restoreArchive(archive),{code:'DEPENDENCY_STALE'});
    assert.equal(dst.service.db.prepare('SELECT count(*) n FROM memories').get().n,0);
    dst.service.selectImportMaintenance(currentMaintenance(s.db));
    await dst.service.applyRevocations([]);
    assert.equal((await dst.service.restoreArchive(archive)).restored,2);
    assert.equal((await dst.service.recall({ids:[child.memory_id],project_id:other})).items[0].revision,2);
    const original=(await dst.service.recall({versions:[ref(parent)],project_id:other})).items[0];
    assert.equal(original.recorded_ownership.project_id,project);
    verify(dst.service);
  } finally {dst.service.close();s.close();}
});

test('pending expiry rejects commit, permits owner renewal and clears candidates idempotently',async()=>{
  const {service:s,config,project}=await setupFake();
  const other=new MemoryService({...config,connection_id:'other-editor'},fake);
  try {
    const p=await propose(s,sameFixture(project,'pending edit'));
    const renew={request_id:id(),proposal_id:p.proposal_id};
    await assert.rejects(async()=>other.renewProposal(renew),{code:'PROPOSAL_OWNER_MISMATCH'});
    assert.deepEqual(s.renewProposal(renew),s.renewProposal(renew));
    s.db.prepare('UPDATE proposals SET expires_at=? WHERE id=?').run(oldTime,p.proposal_id);
    await assert.rejects(commit(s,p),{code:'PROPOSAL_EXPIRED'});
    assert.throws(()=>s.renewProposal({...renew,request_id:id()}),{code:'PROPOSAL_EXPIRED'});
    const input={request_id:id(),action:'expire',proposal_ids:[p.proposal_id]};
    const plan=await s.retention(input);
    const request={...input,plan_hash:plan.plan_hash};
    const result=await s.retention(request,true);
    assert.equal(result.changed,true);
    noBody(s,p.proposal_id);
    assert.equal((await s.retention(request,true)).generation,result.generation);
    await assert.rejects(commit(s,p),{code:'PROPOSAL_EXPIRED'});
  } finally {other.close();s.close();}
});

test('pruning preserves references, archives explicit absence and restores before opening historical data',async()=>{
  const {service:s,config,project,other,root}=await setupFake({all_projects:true});
  try {
    const sourceHash=hash('source for pruned fixture');
    const initial={...sameFixture(project,'old text'),import_key:'early-test-alias',
      sources:[{...source('old-text'),source_hash:sourceHash}]};
    const first=await publish(s,initial);
    let current=await publish(s,sameFixture(project,'revision 2'),{target_id:first.memory_id,expected_revision:1});
    const derived=await publish(s,{...sameFixture(project,'copy referencing revision 2'),derived_from:[ref(current)]});
    await publish(s,sameFixture(project,'updated derivation'),{target_id:derived.memory_id,expected_revision:1});
    for(let i=3;i<=7;i++)current=await publish(s,sameFixture(project,'revision '+i),{target_id:current.memory_id,expected_revision:current.revision});
    s.db.prepare('UPDATE memory_versions SET recorded_at=? WHERE memory_id=? AND revision<7').run(oldTime,current.memory_id);
    const redundant={...sameFixture(project,'legitimate retained source'),sources:[source('shared-source')]};
    const kept=await publish(s,redundant);
    const archived=JSON.parse(await readFile((await s.export(project,false,'versioned')).path,'utf8'));
    const copies=structuredClone(archived);
    copies.records=[copies.records.find(r=>r.id===kept.memory_id)];
    const duplicateId=id();copies.records[0].id=duplicateId;
    await s.applyRevocations([]);
    await s.restoreArchive(copies);
    const moved=await publish(s,sameFixture(project,'requires correct assignment'));
    const forgotten=await publish(s,sameFixture(project,'requires user forgetting'));
    const stagedDir=join(root,'pre-actions');await mkdir(stagedDir);
    const database=join(stagedDir,'recovered.db');
    await backup(s.db,database);

    const reassign={request_id:id(),records:[ref(moved)],destination:{project_id:other,scope:'project'},reason:'Synthetic project evidence'};
    const reassignment=await s.reassign(reassign);
    await s.reassign({...reassign,plan_hash:reassignment.plan_hash},true);
    const blocked=await s.retention({request_id:id(),action:'prune',versions:[{memory_id:first.memory_id,revision:2}]});
    assert.equal(blocked.blocked,true);assert.equal(blocked.impact[0].reason,'referenced');
    const prune={request_id:id(),action:'prune',versions:[ref(first)]};
    const pruning=await s.retention(prune);
    await s.retention({...prune,plan_hash:pruning.plan_hash},true);
    const result=await s.recall({versions:[ref(first),ref(current)]});
    assert.ok(result.warnings.includes('VERSION_PRUNED'));
    assert.deepEqual(result.pruned_versions,[ref(first)]);
    assert.equal(result.items[0].revision,7);
    const v2=JSON.parse(await readFile((await s.export(project,false,'versioned')).path,'utf8'));
    const absent=v2.records.find(r=>r.id===first.memory_id).versions[0];
    assert.equal(absent.body_state,'pruned');
    assert.equal('body' in absent,false);
    assert.ok(absent.aliases.some(a=>a.value===sourceHash));
    const retire={request_id:id(),action:'retire',reason:'redundant',record:{memory_id:duplicateId,revision:1},replacement:ref(kept)};
    const retiring=await s.retention(retire);
    await s.retention({...retire,plan_hash:retiring.plan_hash},true);
    assert.equal((await s.recall({ids:[kept.memory_id,duplicateId]})).items[0].id,kept.memory_id);
    assert.equal(s.db.prepare('SELECT count(*) n FROM tombstones').get().n,0);
    assert.equal(s.previewArchive(copies)[0].action,'blocked_retired');
    await forget(s,{request_id:id(),memory_id:forgotten.memory_id,expected_revision:1});
    const latest=JSON.parse(await readFile(join(root,'maintenance.json'),'utf8'));
    const revocations=(await readFile(join(root,'revocations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    const recovered=new MemoryService({...config,database,maintenance_state:stagedDir},fake,undefined,true);
    try {
      const restored=await recovered.recover(latest,revocations);
      assert.equal(restored.recovered,true);
      assert.deepEqual((await recovered.recall({versions:[ref(first)]})).pruned_versions,[ref(first)]);
      assert.deepEqual((await recovered.recall({ids:[duplicateId,forgotten.memory_id]})).items,[]);
      assert.equal((await recovered.recall({versions:[ref(moved)],project_id:other})).items[0].project_id,other);
      assert.equal((await recovered.recall({versions:[ref(moved)],project_id:project})).items.length,0);
      assert.equal((await recovered.recall({ids:[kept.memory_id]})).items.length,1);
      assert.equal(recovered.previewArchive({...archived,records:archived.records.filter(r=>r.id===first.memory_id)})[0].action,'blocked_pruned');
      verify(recovered);
    } finally {recovered.close();}

    const erased=await forget(s,{request_id:id(),memory_id:current.memory_id,expected_revision:current.revision});
    assert.equal(erased.derived_erased,1);
    const revocation=s.db.prepare("SELECT value FROM revoked_aliases WHERE memory_id=? AND kind='source_hash'").get(current.memory_id);
    assert.equal(revocation.value,sourceHash);
    verify(s);
  } finally {s.close();}
});

for(const action of ['reassign','forget','retention','commit'])test(action+' survives interruption on either side of the commit',async()=>{
  const {service:s,config,project,other,root}=await setupFake({all_projects:true,retention:{keep_revisions:1}});
  const open=()=>new MemoryService(config,fake);
  let read;
  try {
    const saved=await publish(s,sameFixture(project,'interruption '+action));
    const target={memory_id:saved.memory_id,expected_revision:1};
    let input;
    if(action==='reassign') {
      input={request_id:id(),records:[ref(saved)],destination:{scope:'project',project_id:other},reason:'Synthetic scope correction'};
      input.plan_hash=(await s.reassign(input)).plan_hash;
    } else if(action==='forget')input={request_id:id(),...target,plan_hash:s.forgetPreview(target).plan_hash};
    else if(action==='retention') {
      await publish(s,sameFixture(project,'revised retention fixture'),{target_id:saved.memory_id,expected_revision:1});
      s.db.prepare('UPDATE memory_versions SET recorded_at=? WHERE memory_id=? AND revision=1').run(oldTime,saved.memory_id);
      input={request_id:id(),action:'prune',versions:[ref(saved)]};
      input.plan_hash=(await s.retention(input)).plan_hash;
    } else {
      const confirmed={...sameFixture(project,'old rule'),subject_id:'crash-rule',context_key:'stable'};
      const a=await publish(s,confirmed,{target_id:saved.memory_id,expected_revision:1});
      Object.assign(saved,a);
      const p=await propose(s,{...confirmed,content:'New rule after explicit correction.',valid_time:{valid_from:effective}},
        {transition:'supersede',expected_refs:[ref(a)]});
      input={request_id:id(),proposal_id:p.proposal_id,expected_revision:p.expected_revision};
    }
    const before=s.storage.generation();
    const marker=action==='commit'?'predecessors':action==='forget'?'erased':'updated';
    const child=`
      import {MemoryService} from './dist/core/service.js';
      import {fake} from './tests/adaptive-helpers.mjs';
      const [config,action,input,stop]=process.argv.slice(1);
      const service=new MemoryService(JSON.parse(config),fake,point=>{if(point===stop)process.kill(process.pid,'SIGKILL');});
      try {await service[action](JSON.parse(input),true);} finally {service.close();}
    `;
    const crash=point=>spawnSync(process.execPath,['--input-type=module','-e',child,JSON.stringify(config),action,JSON.stringify(input),
      (action==='commit'?'transition':action)+':'+point]);
    const rollback=crash(marker);
    assert.equal(rollback.signal,'SIGKILL',String(rollback.stderr));
    assert.equal(s.storage.generation(),before);
    assert.ok((await s.recall({versions:[ref(saved)],project_id:project})).items.length);
    const committed=crash('committed');
    assert.equal(committed.signal,'SIGKILL',String(committed.stderr));
    read=open();
    assert.equal(read.storage.generation(),before+1);
    if(action==='commit')assert.equal((await read.recall({ids:[saved.memory_id],project_id:project})).items.length,0);
    else assert.equal((await read.recall({versions:[ref(saved)],project_id:project})).items.length,0);
    const result=await read[action](input,true);
    assert.equal(result.generation,before+1);
    if(action==='commit')assert.equal(result.maintenance_synced,true);
    else assert.deepEqual(result.maintenance.errors,[]);
    verify(read);
  } finally {read?.close();s.close();}
});
