import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
import {MemoryService} from '../dist/core/service.js';
import {QueryState} from '../dist/retrieval/state.js';
import {readMaintenance,readRevocations} from '../dist/memory/recovery.js';
import {record,publish,forget,restoreSchema13Storage} from './helpers.mjs';
import {fake,setupFake} from './adaptive-helpers.mjs';

const ref=m=>({memory_id:m.memory_id,revision:m.revision});
const candidate=(r,extra={})=>({request_id:randomUUID(),record:r,...extra});
const commit=(service,draft)=>service.commit({request_id:randomUUID(),proposal_id:draft.proposal_id,expected_revision:draft.expected_revision});
const pref=(project,content,options={})=>record(project,{kind:'preference',title:'Paperclip artifact format',
  subject_id:'paperclip.format',context_key:'release',decision_state:'adopted',content,...options});
const directory=(project,subject,section='current')=>({uri:`sam://projects/${project}/subjects/${encodeURIComponent(subject)}/${section}`});

test('admission separates one-off work, exact duplicates, read-only advice and candidate-bound writes',async()=>{
  const {service:s,config,project}=await setupFake();
  const reader=new MemoryService({...config,connection_id:'scoped-reader',operations:['recall'],allow_global:false},fake);
  const writer=new MemoryService({...config,connection_id:'another-writer'},fake);
  try {
    const r=pref(project,'Paperclip uses dashed output by default.'),input=candidate(r);
    const generation=s.storage.generation();
    assert.equal((await s.admissionPreview({candidate:input,intent:'receipt'})).action,'skip');
    assert.equal((await s.admissionPreview({candidate:input,intent:'temporary'})).action,'task_override');
    const review=await s.admissionPreview({candidate:input});
    assert.equal(review.action,'new');
    assert.ok(review.admission_id);
    assert.equal(s.db.prepare('SELECT count(*) n FROM proposals').get().n,0);
    assert.equal(s.storage.generation(),generation);
    const readOnly=await reader.admissionPreview({candidate:input});
    assert.equal(readOnly.admission_id,undefined);
    assert.deepEqual(readOnly.blockers,['OPERATION_DENIED:propose','OPERATION_DENIED:commit']);
    await assert.rejects(writer.propose({...input,admission_id:review.admission_id}),{code:'ADMISSION_EXPIRED_OR_UNAVAILABLE'});
    await assert.rejects(s.propose({...input,record:{...r,content:'Changed'},admission_id:review.admission_id}),{code:'ADMISSION_CANDIDATE_MISMATCH'});
    const draft=await s.propose({...input,admission_id:review.admission_id});
    await assert.rejects(commit(writer,draft),{code:'ADMISSION_EXPIRED_OR_UNAVAILABLE'});
    const m=await commit(s,draft);
    const duplicate=await s.admissionPreview({candidate:candidate(r)});
    assert.equal(duplicate.action,'no_change');
    assert.deepEqual(duplicate.duplicate,ref(m));
    const ambiguous=await s.admissionPreview({candidate:candidate({...r,content:'Paperclip uses wrapped output.'})});
    assert.equal(ambiguous.action,'conflict');
    const variant=await s.admissionPreview({candidate:candidate({...r,context_key:'preview'}),intent:'variant'});
    assert.equal(variant.action,'context_variant');
    const expired=QueryState.open(s.db,s.config);
    expired.db.prepare("UPDATE frontier_leases SET expires=0 WHERE kind='admission' AND id=?").run(variant.admission_id);
    await assert.rejects(s.propose(candidate({...r,context_key:'preview'},{admission_id:variant.admission_id})),{code:'ADMISSION_EXPIRED_OR_UNAVAILABLE'});
  } finally {s.close();reader.close();writer.close();}
});

test('an admission invalidated while embedding cannot publish and direct proposals retain revision CAS',async()=>{
  const {service:s,config,project}=await setupFake();
  const r=pref(project,'Paperclip outputs eight lines.');
  const m=await publish(s,r), input=candidate({...r,content:'Paperclip outputs six lines.'},{target_id:m.memory_id,expected_revision:1});
  const approval=await s.admissionPreview({candidate:input,intent:'correct'});
  assert.equal(approval.action,'correct');
  const draft=await s.propose({...input,admission_id:approval.admission_id});
  const sibling=new MemoryService(config,fake);
  s.encoder={...fake,chunks:async (...args)=>{
    await publish(sibling,{...r,content:'Paperclip outputs seven lines.'},{target_id:m.memory_id,expected_revision:1});
    return fake.chunks(...args);
  }};
  try {
    await assert.rejects(commit(s,draft),{code:'ADMISSION_STALE'});
    const current=(await s.inspectMemory({memory_id:m.memory_id,project_id:project})).items[0];
    assert.equal(current.revision,2);
    assert.match(current.content,/seven lines/);
    await assert.rejects(s.propose(inputWithFreshRequest(input)),{code:'VERSION_CONFLICT'});
  } finally{s.close();sibling.close();}
});
function inputWithFreshRequest(input){return {...input,request_id:randomUUID()};}

test('admission connects a documented rule change to an existing successor and retains its predecessor',async()=>{
  const {service:s,project}=await setupFake();
  try {
    const former=pref(project,'Release uses the narrow header.');
    const first=await publish(s,former);
    const next={...former,content:'Release uses the full header.',decision_state:'proposed'};
    const draft=await publish(s,next);
    const input=candidate({...next,decision_state:'adopted',valid_time:{valid_from:new Date().toISOString()}},
      {target_id:draft.memory_id,expected_revision:draft.revision,expected_refs:[ref(first)],transition:'supersede'});
    const review=await s.admissionPreview({candidate:input,intent:'supersede'});
    assert.equal(review.action,'supersede');
    const change=await commit(s,await s.propose({...input,admission_id:review.admission_id}));
    assert.equal(change.memory_id,draft.memory_id);
    assert.equal(change.revision,2);
    assert.equal(s.browse(directory(project,former.subject_id)).items[0].memory_id,draft.memory_id);
    assert.ok(s.browse(directory(project,former.subject_id,'history')).items.some(item=>item.memory_id===first.memory_id&&item.lifecycle==='historical'));
    assert.equal((await s.inspectMemory(ref(first))).items[0].content,former.content);
    assert.equal(s.db.prepare('SELECT count(*) n FROM memories').get().n,2);
  }finally{s.close();}
});

test('the catalog applies ownership, effective context and exact-revision projections before disclosure',async()=>{
  const {service:s,config,project,other,root}=await setupFake();
  const r=record(project,{kind:'decision',title:'Old paperclip profile',content:'Release profile requires the short header.',
    valid_for:{environment:'prod'},decision_state:'adopted',sources:[{
      source_type:'document',uri:join(root,'no-longer-here.md'),locator:'Sampling',revision_ref:'v1',checked_at:'2026-01-01T00:00:00.000Z'
    }]});
  const stored=await publish(s,{...r,decision_state:'unknown'});
  const foreign=await publish(s,pref(other,'PRIVATE OTHER TENANT SUBJECT.',{subject_id:'private.subject'}));
  const classify={records:[{...ref(stored),subject_id:'release.profile',context_key:'prod',aliases:['old profile'],start:0,end:r.content.length}]};
  const admin=s.classify(classify);
  assert.equal(admin.records[0].sources[0].state,'missing');
  assert.equal(s.browse({uri:`sam://projects/${project}/subjects/`}).count,0);
  assert.equal(s.classify({...classify,plan_hash:admin.plan_hash},true).attached,1);
  const reader=new MemoryService({...config,connection_id:'catalog-reader',allowed_projects:[project],allow_global:false,operations:['recall']},fake);
  try {
    assert.equal(reader.browse({uri:'sam://projects/'}).count,1);
    assert.throws(()=>reader.browse(directory(other,'private.subject')),{code:'SCOPE_DENIED'});
    assert.deepEqual(reader.explainMemory(ref(foreign)),{state:'not_visible'});
    assert.equal(reader.browse({...directory(project,'old profile','evidence'),context:{environment:'stage'}}).count,0);
    const found=reader.browse({...directory(project,'old profile','evidence'),context:{environment:'prod'},context_key:'prod'});
    assert.equal(found.count,1);
    assert.deepEqual(found.items[0].span,{start:0,end:r.content.length,text:r.content});
    assert.equal(found.items[0].revision,1);
    assert.equal(reader.browse(directory(project,'old profile')).count,0);
    assert.equal(reader.browse({uri:'sam://maintenance/source-gaps/'}).count,1);
    assert.equal(reader.explainMemory({memory_id:stored.memory_id,context:{environment:'stage'}}).reason,'context_mismatch');
    const draft=await s.propose(candidate(record(project,{title:'Pending visibility check',content:'Uncommitted content.'})));
    assert.equal(s.browse({uri:'sam://maintenance/pending/'}).items[0].proposal_id,draft.proposal_id);
    assert.equal(reader.browse({uri:'sam://maintenance/pending/'}).count,0);
    const corrected=await publish(s,{...r,decision_state:'unknown',content:'Release profile requires a full header.'},
      {target_id:stored.memory_id,expected_revision:1});
    assert.equal(reader.browse(directory(project,'old profile','evidence')).count,0);
    assert.equal(reader.browse({uri:'sam://maintenance/unclassified/'}).items[0].revision,corrected.revision);
    assert.throws(()=>s.classify({...classify,plan_hash:admin.plan_hash},true),{code:'VERSION_CONFLICT'});
    assert.equal(s.check().projection_mismatch.n,0);
  }finally{reader.close();s.close();}
});

test('task override covers aliases, prior revisions, derived evidence, query pages and authenticated connections',async()=>{
  const {service:s,config,project}=await setupFake({graph_enabled:true});
  const r=pref(project,'Paperclip artifact format uses Amber.');
  const a=await publish(s,r);
  const b=await publish(s,record(project,{title:'Paperclip procedure',content:'Paperclip artifact format uses Amber in the prepared template.',
    derived_from:[ref(a)],subject_id:'paperclip.template',context_key:'release'}));
  const sibling=await publish(s,record(project,{title:'Paperclip release details',content:'Paperclip artifact format preserves the Amber separator.',
    subject_id:r.subject_id,context_key:r.context_key}));
  const unrelated=[];
  for(let i=0;i<4;i++)unrelated.push(await publish(s,record(project,{title:'Paperclip artifact reference '+i,content:'Paperclip artifact format reference '+i+'.'})));
  const identity={...ref(a),subject_id:r.subject_id,context_key:r.context_key,aliases:['format preference'],start:0,end:r.content.length};
  const {plan_hash}=s.classify({records:[identity]});
  s.classify({records:[identity],plan_hash},true);
  const task_id=randomUUID();
  const overlay={task_id,exclude_subjects:[{owner:{scope:'project',project_id:project},subject_id:'format preference',context_key:'release'}]};
  const other=new MemoryService({...config,connection_id:'someone-else'},fake);
  try {
    assert.equal(s.taskOverride(overlay).task_id,task_id);
    assert.throws(()=>s.taskOverride({task_id,exclude_ids:[b.memory_id]}),{code:'TASK_OVERRIDE_EXISTS'});
    await assert.rejects(other.recall({ids:[a.memory_id],task_id}),{code:'TASK_OVERRIDE_UNAVAILABLE'});
    assert.equal((await s.recall({versions:[ref(a),ref(b),ref(sibling)],task_id})).items.length,0);
    assert.equal(s.browse({...directory(project,r.subject_id,'history'),task_id}).count,0);
    assert.equal(s.explainMemory({...ref(b),task_id}).reason,'task_override');
    const query={query:'Paperclip artifact format',project_id:project,task_id,graph:true,limit:1};
    const first=await s.recall(query);
    assert.ok(first.next_cursor);
    assert.ok(first.items.every(i=>[...unrelated].some(x=>x.memory_id===i.id)));
    const more=await s.recall({cursor:first.next_cursor});
    assert.ok(more.items.every(i=>[...unrelated].some(x=>x.memory_id===i.id)));
    const state=QueryState.open(s.db,s.config);
    state.db.prepare("UPDATE frontier_leases SET expires=0 WHERE kind='task' AND id=?").run(task_id);
    await assert.rejects(s.recall({cursor:first.next_cursor}),{code:'TASK_OVERRIDE_UNAVAILABLE'});
    s.taskOverride({...overlay,exclude_subjects:[],exclude_ids:[b.memory_id]});
    await assert.rejects(s.recall({cursor:first.next_cursor}),{code:'CURSOR_TASK_CHANGED'});
    assert.equal((await s.recall({ids:[a.memory_id]})).items[0].content,r.content);
  }finally{other.close();s.close();}
});

test('evidence packets retain exact spans and mark incomplete source coverage and shared source families',async()=>{
  const {service:s,config,project,root}=await setupFake({context_pack_enabled:true});
  const reader=new MemoryService({...config,context_pack_enabled:false},fake);
  try {
    const old=pref(project,'Use at most 11 entries, never 12 unless staging.',{valid_for:{environment:'prod'}});
    const src={...old.sources[0],source_hash:'a'.repeat(64)};
    const a=await publish(s,{...old,sources:[{...src,uri:join(root,'missing.md')}]});
    const b=await publish(s,record(project,{title:'Independent label on mirrored report',content:'Same evidence says never use 12.',
      sources:[{...src,uri:'https://example.invalid/mirror'}]}));
    await assert.rejects(reader.contextPack({needed:false}),{code:'CONTEXT_PACK_DISABLED'});
    assert.equal((await s.contextPack({needed:false})).evidence_status,'not_needed');
    const response=await s.contextPack({read:{ids:[a.memory_id,b.memory_id],project_id:project,context:{environment:'prod'}}});
    assert.equal(response.pack,'deterministic-v1');
    assert.equal(response.evidence_status,'requires_check');
    assert.equal(response.source_families,1);
    assert.ok(response.warnings.includes('SOURCE_GAP'));
    assert.deepEqual(response.items[0].spans,[{start:0,end:old.content.length,text:old.content}]);
    assert.equal(response.items[0].conditions.environment,'prod');
    const task_id=randomUUID();
    s.taskOverride({task_id,exclude_ids:[a.memory_id]});
    assert.equal((await s.contextPack({read:{versions:[ref(a)],task_id}})).evidence_status,'insufficient');
  }finally{s.close();reader.close();}
});

const contradiction=(target,sources)=>({expected_refs:[ref(target)],
  relations:[{type:'contradicts',target_id:target.memory_id,sources}]});

test('evidence packets flag either end of a contradiction without disclosing an off-page end',async()=>{
  const {service:s,project}=await setupFake({context_pack_enabled:true});
  try {
    const claim=record(project,{kind:'fact',title:'Oriole release marker',content:'The Oriole release marker is amber.',
      subject_id:'release.marker',context_key:'stable'});
    const a=await publish(s,claim);
    const b=await publish(s,{...claim,content:'The Oriole release marker is indigo.'},contradiction(a,claim.sources));
    const both=await s.contextPack({read:{versions:[ref(a),ref(b)]}});
    assert.equal(both.conflicts.length,1);
    assert.deepEqual(both.items.map(item=>item.use),['conflict','conflict']);
    assert.equal(s.browse(directory(project,claim.subject_id,'conflicts')).count,1);
    for(const [shown,other] of [[a,b],[b,a]]) {
      const one=await s.contextPack({read:{versions:[ref(shown)]}});
      assert.equal(one.evidence_status,'requires_check');
      assert.equal(one.items[0].use,'conflict');
      assert.deepEqual(one.conflicts,[]);
      assert.ok(!JSON.stringify(one).includes(other.memory_id));
    }
    const first=await s.contextPack({read:{query:'Oriole release marker',project_id:project,limit:1}});
    const next=await s.contextPack({read:{cursor:first.next_cursor}});
    assert.deepEqual(new Set([first.items[0].memory_id,next.items[0].memory_id]),new Set([a.memory_id,b.memory_id]));
    assert.deepEqual([first,next].map(page=>[page.evidence_status,page.items[0].use,page.conflicts.length]),
      [['requires_check','conflict',0],['requires_check','conflict',0]]);
  }finally{s.close();}
});

test('evidence packet conflicts honor the inherited task, scope, effective time and current revision',async()=>{
  const {service:s,config,project,other}=await setupFake({context_pack_enabled:true});
  const scoped=new MemoryService({...config,allowed_projects:[project],allow_global:false},fake);
  try {
    const claim=record(project,{kind:'fact',title:'Kestrel release marker',content:'The Kestrel release marker is amber.'});
    const a=await publish(s,claim);
    const b=await publish(s,{...claim,content:'The Kestrel release marker is blue.',valid_for:{environment:'staging'}},
      contradiction(a,claim.sources));
    const expired=await publish(s,{...claim,content:'The Kestrel release marker is gray.',
      valid_for:{expires_at:'2023-01-01T00:00:00.000Z'}},contradiction(a,claim.sources));
    const foreign=await publish(s,record(other,{kind:'fact',title:claim.title,content:'The Kestrel release marker is private.'}));
    // Exercise a legacy edge across owners that the current write API rejects.
    s.db.prepare(`INSERT INTO memory_relations(id,revision,from_id,from_revision,to_id,to_revision,type,project_id,scope,sources,recorded_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(),1,a.memory_id,1,foreign.memory_id,1,'contradicts',project,'project',JSON.stringify(claim.sources),new Date().toISOString());
    const visible={ids:[a.memory_id],project_id:project,context:{environment:'staging'}};
    const clean=page=>{
      assert.equal(page.evidence_status,'related_evidence');
      assert.ok(!page.warnings.includes('RECORDED_CONFLICT'));
      assert.deepEqual(page.conflicts,[]);
      assert.ok(page.items.every(item=>item.use!=='conflict'));
    };
    assert.equal((await scoped.contextPack({read:visible})).items[0].use,'conflict');
    clean(await scoped.contextPack({read:{...visible,context:{environment:'production'}}}));
    const task_id=randomUUID();
    scoped.taskOverride({task_id,exclude_ids:[b.memory_id]});
    clean(await scoped.contextPack({read:{...visible,task_id}}));
    await publish(s,{...claim,content:'The Kestrel release manual describes the fixture.'});
    const first=await scoped.contextPack({read:{query:'Kestrel release marker',project_id:project,
      context:{environment:'staging'},task_id,exclude_ids:[expired.memory_id],limit:1}});
    clean(first);
    assert.ok(first.next_cursor);
    clean(await scoped.contextPack({read:{cursor:first.next_cursor}}));
    await publish(s,{...claim,content:'The Kestrel release marker is corrected to amber.'},
      {target_id:b.memory_id,expected_revision:b.revision});
    await assert.rejects(scoped.contextPack({read:{cursor:first.next_cursor}}),{code:'CURSOR_STALE'});
    clean(await scoped.contextPack({read:visible}));
    const replacement=await publish(s,{...claim,content:'The Kestrel release marker is copper.'},contradiction(a,claim.sources));
    await forget(s,{memory_id:replacement.memory_id,expected_revision:replacement.revision,request_id:randomUUID()});
    clean(await scoped.contextPack({read:visible}));
  }finally{scoped.close();s.close();}
});

test('tight evidence pack budgets preserve conflict annotations in the raw page',async()=>{
  const {service:s,project}=await setupFake({context_pack_enabled:true});
  try {
    const claims=[];
    for(let n=0;n<10;n++){
      const base=record(project,{kind:'fact',title:'Finch verification marker '+n,content:'Finch marker fixture '+n});
      const sources=[{...base.sources[0],uri:'test://marker/'+n}];
      const links=claims.length?{expected_refs:claims.map(ref),
        relations:claims.map(target=>contradiction(target,sources).relations[0])}:{};
      claims.push(await publish(s,{...base,sources},links));
    }
    const read={query:'Finch verification marker fixture',view:'evidence',limit:10};
    const ordinary=await s.recall(read);
    assert.equal(ordinary.items.length,claims.length);
    const max_bytes=Buffer.byteLength(JSON.stringify(ordinary))+300;
    const result=await s.contextPack({read:{...read,max_bytes,token_budget:Math.floor(max_bytes/3)}});
    assert.equal(result.pack,'raw_fallback');
    assert.equal(result.evidence_status,'requires_check');
    assert.ok(result.warnings.includes('RECORDED_CONFLICT'));
    assert.ok(result.items.every(item=>item.applicability==='requires_check'));
    assert.deepEqual(result.items.map(({id,revision,content,excerpts})=>({id,revision,content,excerpts})),
      ordinary.items.map(({id,revision,content,excerpts})=>({id,revision,content,excerpts})));
    assert.ok(Buffer.byteLength(JSON.stringify(result))<=max_bytes);
  }finally{s.close();}
});

test('a pack assembled across a concurrent erasure requests a fresh read',async()=>{
  const {service:s,config,project}=await setupFake({context_pack_enabled:true});
  const claim=record(project,{kind:'fact',title:'Dipper release marker',content:'Dipper marker is silver.'});
  const a=await publish(s,claim);
  const b=await publish(s,{...claim,content:'Dipper marker is copper.'},contradiction(a,claim.sources));
  let erasure;
  const reader=new MemoryService(config,fake,point=>{
    if(point==='recall:canonical_released'&&!erasure)
      erasure=forget(s,{memory_id:b.memory_id,expected_revision:b.revision,request_id:randomUUID()});
  });
  try {
    await assert.rejects(reader.contextPack({read:{ids:[a.memory_id]}}),{code:'VIEW_STALE'});
    await erasure;
    const page=await reader.contextPack({read:{ids:[a.memory_id]}});
    assert.equal(page.evidence_status,'related_evidence');
    assert.deepEqual(page.conflicts,[]);
  }finally{reader.close();s.close();}
});

test('an old schema backup reconciles erasure before rebuilding a catalog',async()=>{
  const {service:s,config,project,root}=await setupFake();
  const base=pref(project,'A formerly used serialized setting.');
  const a=await publish(s,base), id=a.memory_id;
  const classification={records:[{...ref(a),subject_id:base.subject_id,context_key:base.context_key,aliases:['old serialization'],start:0,end:base.content.length}]};
  const stage=join(root,'stage.db');
  await backup(s.db,stage);
  const bare=new DatabaseSync(stage);restoreSchema13Storage(bare);bare.close();
  const plan=s.classify(classification);
  s.classify({...classification,plan_hash:plan.plan_hash},true);
  await forget(s,{memory_id:id,expected_revision:1,request_id:randomUUID()});
  const recovery=new MemoryService({...config,database:stage,all_projects:true,maintenance_state:join(root,'restore-state')},fake,undefined,true);
  try {
    assert.equal(s.db.prepare('SELECT count(*) n FROM claim_projection').get().n,0);
    await recovery.recover(readMaintenance(join(root,'maintenance.json')),readRevocations(join(root,'revocations.jsonl')));
    assert.equal(recovery.storage.schema(),14);
    assert.equal(recovery.browse(directory(project,base.subject_id,'history')).count,0);
    assert.equal((await recovery.inspectMemory(ref(a))).items.length,0);
    assert.equal(recovery.check().projection_mismatch.n,0);
  }finally{recovery.close();s.close();}
});

test('rc2 admission accepts omitted preview request_id, normalizes default fields, tolerates unrelated commits, and blocks same-subject conflicts',async()=>{
  const {service:s,project}=await setupFake();
  try {
    const r=record(project,{kind:'fact',title:'Offset and admission fixture',content:'Initial claim for admission normalization.'});
    delete r.tags;
    const preview=await s.admissionPreview({candidate:{record:r}});
    assert.equal(preview.action,'new');
    assert.ok(preview.admission_id);
    // Adding transition:'new' and explicit tags:[] on new record matches digest
    const draft=await s.propose({request_id:randomUUID(),admission_id:preview.admission_id,transition:'new',record:{...r,tags:[]}});
    // Unrelated concurrent commit advances generation without invalidating admission_id
    await publish(s,record(project,{kind:'fact',title:'Unrelated concurrent record',content:'Independent fact advancing generation.'}));
    const committed=await commit(s,draft);
    assert.equal(committed.revision,1);

    // On updates, omitting vs clearing tags:[] must still mismatch due to inheritance semantics
    const updateBase=record(project,{kind:'fact',title:'Update tag override check',content:'Original body.',tags:['keep-tag']});
    const m=await publish(s,updateBase);
    const updPreview=await s.admissionPreview({candidate:{target_id:m.memory_id,expected_revision:1,record:{...updateBase,content:'Edited body.',tags:[]}}});
    const omitTags={...updateBase,content:'Edited body.'};
    delete omitTags.tags;
    await assert.rejects(s.propose({request_id:randomUUID(),admission_id:updPreview.admission_id,target_id:m.memory_id,expected_revision:1,record:omitTags}),{code:'ADMISSION_CANDIDATE_MISMATCH'});

    // Same (subject_id, context_key) concurrent commit MUST mark admission stale
    const ruleA=pref(project,'Rule A version 1.',{subject_id:'concurrent.rule',context_key:'prod',decision_state:'proposed'});
    const ruleB=pref(project,'Rule B version 1.',{subject_id:'concurrent.rule',context_key:'prod',decision_state:'proposed'});
    const pRule=await s.admissionPreview({candidate:{record:ruleA}});
    const dRule=await s.propose({request_id:randomUUID(),admission_id:pRule.admission_id,record:ruleA});
    await publish(s,ruleB);
    await assert.rejects(commit(s,dRule),{code:'ADMISSION_STALE'});
  } finally {s.close();}
});

test('rc2 accepts ISO-8601 timezone offsets and returns actionable rule/transition hints',async()=>{
  const {service:s,project}=await setupFake();
  try {
    const offsetRecord=record(project,{
      kind:'fact',title:'Timezone offset fixture',content:'Valid during CST business window.',
      sources:[{source_type:'user',uri:'codex://thread/tz',locator:'offset timestamp',revision_ref:'v1',checked_at:'2026-11-22T08:00:00+08:00'}],
      valid_for:{expires_at:'2099-01-01T08:00:00+08:00'},
      valid_time:{valid_from:'2026-11-22T00:00:00+08:00',valid_to:'2026-12-22T00:00:00+08:00'}
    });
    const saved=await publish(s,offsetRecord);
    assert.equal((await s.recall({ids:[saved.memory_id],as_of:'2026-11-21T15:59:59+00:00'})).items.length,0);
    assert.equal((await s.recall({ids:[saved.memory_id],as_of:'2026-11-21T16:00:00+00:00'})).items[0].id,saved.memory_id);

    await assert.rejects(
      s.propose({request_id:randomUUID(),record:record(project,{kind:'preference',decision_state:'adopted',title:'Missing subject rule',content:'Needs identity.'})}),
      err=>err.code==='RULE_IDENTITY_REQUIRED'&&Boolean(err.details?.hint?.includes('subject_id'))
    );
    const legacy=await publish(s,record(project,{kind:'fact',title:'Legacy record without subject',content:'Legacy content.'}));
    await assert.rejects(
      s.propose({request_id:randomUUID(),transition:'supersede',expected_refs:[ref(legacy)],record:record(project,{kind:'fact',subject_id:'sub.x',context_key:'ctx.x',valid_time:{valid_from:'2026-11-22T00:00:00+08:00'}})}),
      err=>err.code==='TRANSITION_SUBJECT_MISMATCH'&&Boolean(err.details?.hint?.includes('without transition'))
    );
  } finally {s.close();}
});
