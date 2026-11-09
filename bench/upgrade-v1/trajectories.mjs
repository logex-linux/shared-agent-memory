import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { mkdtemp,realpath,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backup } from 'node:sqlite';
import { MemoryService } from '../../dist/core/service.js';
import { BgeEncoder } from '../../dist/embedding/bge.js';
import { fingerprint,tasks } from './tasks.mjs';

const [output,baseline]=process.argv.slice(2);
if(!output||!baseline)throw Error('Usage: trajectories.mjs EXISTING_OUTPUT_DIRECTORY BASELINE_DIST');
const root=await mkdtemp(join(await realpath(output),'trajectories-'));
const {MemoryService:Legacy}=await import(pathToFileURL(join(resolve(baseline),'core/service.js')));
const options={model_dir:resolve('.local/models/bge-small-zh-v1.5'),dtype:'fp32',threads:2};
const encoder=new BgeEncoder(options);
const encoded=new Map();
const shared={
  profile:()=>encoder.profile(),query:text=>encoder.query(text),
  chunks(title,content) {
    const key=JSON.stringify([title,content]);
    if(!encoded.has(key))encoded.set(key,encoder.chunks(title,content));
    return encoded.get(key);
  }
};
const categories=[...new Set(tasks.map(task=>task.category))];
const domains=Object.fromEntries([...categories,'foreign'].map((category,index)=>[
  category,'a8aa9e42-536e-4d68-87a2-'+String(index+1).padStart(12,'0')
]));
const checked_at='2026-06-01T00:00:00.000Z';
const baseConfig={...options,allowed_projects:categories.map(category=>domains[category]),allow_global:false,operations:['recall']};
const writerConfig={...baseConfig,allowed_projects:Object.values(domains),all_projects:true,allow_global:true,
  operations:['recall','propose','commit','manage','forget']};
const makeSource=record=>({source_type:'test',uri:record.source,locator:'frozen source event',revision_ref:fingerprint,checked_at});
const refs=result=>({memory_id:result.memory_id,revision:result.revision});
const key=ref=>ref.memory_id+':'+ref.revision;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const services=[];
function open(Service,config){
  assert.equal(resolve(config.database,'..'),root);
  const service=new Service(config,shared);
  services.push(service);
  return service;
}
async function publish(service,record,options={}) {
  const draft=await service.propose({request_id:randomUUID(),record,...options});
  return service.commit({request_id:randomUUID(),proposal_id:draft.proposal_id,expected_revision:draft.expected_revision});
}

async function populate(service,modern) {
  for(const [category,project] of Object.entries(domains)) {
    const alias=await mkdtemp(join(root,'project-'));
    await service.project(project,category,alias);
  }
  const registry=new Map();
  for(const task of tasks) {
    const material=Object.fromEntries(task.records.map(record=>[record.key,record]));
    const saved={};
    function body(record) {
      const project_id=domains[record.project==='foreign'?'foreign':task.category];
      return {project_id,scope:'project',kind:'fact',title:record.title,content:record.content,tags:[],
        sources:[makeSource(record)],valid_for:record.environment?{environment:record.environment}:{},
        author_client:'evaluation',author_session:task.id,
        verification:{method:'frozen synthetic source',summary:'Auditable fictional event for retrieval evaluation.'},
        derived_from:(record.derived_from??[]).map(dep=>refs(saved[dep.key])),
        ...(modern&&{subject_id:record.subject,context_key:'operational incident',
          ...(record.event_time&&{memory_form:'episodic',episode:{event_time:record.event_time}}),
          ...(record.valid_from&&{valid_time:{valid_from:record.valid_from,...(record.valid_to&&{valid_to:record.valid_to})}}),
          ...(record.decision_state&&{decision_state:record.decision_state})})};
    }
    const relation=(target,type,record)=>({expected_refs:[refs(saved[target])],
      relations:[{target_id:saved[target].memory_id,type,sources:[makeSource(record)]}]});
    const original={};
    // Dependency order allows first-publication relations without rewriting source revisions.
    if(task.category==='cross-event') {
      for(const [record,target,type] of [['check'],['cause','check','supports'],['incident','cause','related_to'],['distractor']])
        saved[record]=await publish(service,body(material[record]),modern&&target?relation(target,type,material[record]):{});
    } else {
      if(task.category==='forget')saved.independent=await publish(service,body(material.independent));
      for(const step of task.steps) {
        if(step.type==='new' && !saved[step.record]) {
          const linked=modern&&task.category==='forget'&&step.record==='original';
          const source={...material[step.record],...(step.derived_from&&{derived_from:step.derived_from})};
          saved[step.record]=await publish(service,body(source),
            linked?relation('independent','related_to',material[step.record]):{});
        } else if(step.type==='update') {
          original[step.target]=saved[step.target];
          saved[step.target]=await publish(service,body(material[step.record]),
            {target_id:saved[step.target].memory_id,expected_revision:step.expected_revision});
        } else if(step.type==='branch') {
          saved[step.record]=await publish(service,body(material[step.record]),
            modern?{transition:'branch',expected_refs:[refs(saved[step.target])]}:{});
        } else if(step.type==='forget') {
          const result=await service.forget({request_id:randomUUID(),memory_id:saved[step.target].memory_id,expected_revision:step.expected_revision});
          assert.equal(result.derived_erased,1);
        }
      }
    }
    registry.set(task.id,{saved,original,material});
  }
  return registry;
}

function signature(service) {
  const rows=service.db.prepare('SELECT body FROM memories').all().map(({body})=>{
    const {project_id,title,content,sources}=JSON.parse(body);
    return JSON.stringify([project_id,title,content,sources]);
  }).sort();
  return hash(rows);
}

function request(task,modern,graph,debug=true) {
  const {project:label,...extra}=task.request;
  const context=extra.context?{context:extra.context}:{};
  return {query:task.query,project_id:domains[task.category],mode:'focused',view:'evidence',limit:5,
    debug,token_budget:6000,max_bytes:32000,...context,...(modern&&{...extra,graph})};
}

async function teach(service,registry) {
  const trained=[];
  // Only frozen development families supply a prior synthetic task outcome.
  for(const task of tasks.filter(t=>t.split==='dev'&&t.category==='cross-event')) {
    const {saved,material}=registry.get(task.id);
    const used=[refs(saved.incident),refs(saved.check)];
    const page=await service.recall({query:material.incident.title+' '+material.check.content,
      project_id:domains[task.category],mode:'broad',view:'evidence',limit:12,context:task.request.context});
    if(!used.every(ref=>page.items.some(item=>item.id===ref.memory_id&&item.revision===ref.revision)))continue;
    const result=await service.feedback({request_id:randomUUID(),task_id:randomUUID(),page_receipt:page.feedback_receipt,
      used,outcome:'useful',basis:'test_result',evidence_ref:'test://v1/prior-outcome/'+task.id});
    assert.equal(result.weight_eligible,true);
    trained.push(task.id);
  }
  return {trained,projection:service.projectFeedback()};
}

async function consolidate(service,registry) {
  const derived=[];
  for(const task of tasks.filter(t=>t.category==='consolidation')) {
    const {saved,material}=registry.get(task.id);
    const citation=record=>({...refs(saved[record]),start:0,end:material[record].content.length});
    // Use the source event wording. The evaluation answer label is not a generator input.
    const claim=material.reproduction.content.split('The reproducible check was to ')[1]?.replace(/\.$/,'');
    assert.ok(claim);
    const report=service.consolidate({project_id:domains[task.category],scope:'project',kind:'procedure',
      title:task.family+' reproducible diagnostic check',claim,
      evidence:{citations:['incident','retelling','reproduction'].map(citation)}});
    assert.equal(report.status,'candidate');
    assert.equal(report.independent_support_groups,task.expected.independent_sources);
    const summary=await publish(service,{...report.candidate,author_client:'evaluation',author_session:task.id});
    derived.push({task:task.id,ref:refs(summary),support_groups:report.independent_support_groups});
  }
  return derived;
}

// One deterministic source-span answer model for every arm. It only sees the
// task category and returned excerpts. Expected answers are used by score().
function answerFrom(category,items) {
  for(const item of items) {
    let span;
    switch(category) {
      case 'cross-event':
        span=item.content.match(/The follow-up check was to (.+?)\./i)?.[1];
        break;
      case 'consolidation':
        span=item.consolidation?item.content:item.content.match(/(?:check was to|had to|says to) (.+?)\./i)?.[1];
        break;
      case 'forget':
        span=item.content.match(/investigation confirmed that (.+?)\./i)?.[1];
        break;
      case 'decision':
        if(item.answer_relevance?.state==='implemented')
          span=item.content.match(/(?:adopted|implemented) (.+?) for /i)?.[1];
        break;
      default:
        span=item.content.match(/\buses (.+?) for /i)?.[1];
    }
    if(span)return span.trim();
  }
  return null;
}

function score(task,state,result) {
  const {saved,original,material}=state;
  const items=result.items;
  const expected=task.expected.evidence.map(entry=>({id:saved[entry.key].memory_id,revision:entry.revision,
    source:material[entry.source??entry.key].source}));
  const rawMatch=(item,ref)=>item.id===ref.id&&item.revision===ref.revision&&item.sources.some(source=>source.uri===ref.source);
  const match=(item,ref)=>rawMatch(item,ref)||Boolean(item.consolidation?.citations.some(c=>
    c.memory_id===ref.id&&c.revision===ref.revision&&c.role==='support')&&item.sources.some(source=>source.uri===ref.source));
  const raw=expected.filter(ref=>items.some(item=>rawMatch(item,ref))).length;
  const covered=expected.filter(ref=>items.some(item=>match(item,ref))).length;
  const excluded=(task.expected.excludes??[]).map(entry=>({id:(original[entry.key]??saved[entry.key]).memory_id,revision:entry.revision}));
  const violations=excluded.filter(ref=>items.some(item=>item.id===ref.id&&item.revision===ref.revision));
  const answer_value=answerFrom(task.category,items);
  const answer=answer_value===task.expected.answer&&(answer_value===null?result.evidence_status==='insufficient':
    items.some(item=>expected.some(ref=>match(item,ref))&&item.content.includes(answer_value)));
  const p1=expected.length?Boolean(items[0]&&expected.some(ref=>match(items[0],ref))):items.length===0;
  return {ok:answer&&covered===expected.length&&!violations.length,p1,answer,answer_value,
    raw_recall:expected.length?raw/expected.length:null,provenance_recall:expected.length?covered/expected.length:null,
    violation_count:violations.length,status:result.evidence_status,
    evidence:items.map(item=>({source:item.sources[0]?.uri,revision:item.revision,path:item.graph_path?.steps.map(step=>step.type)}))};
}

const report={fingerprint,model:(await shared.profile()).id,answer_model:'fixed source-span extraction v1',
  scorer:'deterministic frozen answers, source/revision labels and exclusions',
  samples:[],learned:{},consolidated:[]};
try {
  const a=open(Legacy,{...writerConfig,database:join(root,'a.db')});
  const b=open(MemoryService,{...writerConfig,database:join(root,'b.db')});
  const legacyRefs=await populate(a,false);
  const modernRefs=await populate(b,true);
  report.raw_evidence_hash=signature(a);
  assert.equal(signature(b),report.raw_evidence_hash);
  const writeArm=async label=>{
    const database=join(root,label+'.db');
    await backup(b.db,database);
    return open(MemoryService,{...writerConfig,database,operations:[...writerConfig.operations,'feedback'],
      feedback_policy:'trusted_outcomes',graph_enabled:true,learned_graph_enabled:true,connection_id:'evaluation:'+label});
  };
  const d=await writeArm('d'),e=await writeArm('e');
  report.learned.D=await teach(d,modernRefs);
  report.learned.E=await teach(e,modernRefs);
  report.consolidated=await consolidate(e,modernRefs);
  const reader=(Service,db,graph,learned)=>open(Service,{...baseConfig,database:db,
    ...(Service===MemoryService&&{graph_enabled:graph,learned_graph_enabled:learned})});
  const arms={A:reader(Legacy,a.config.database,false,false),B:reader(MemoryService,b.config.database,false,false),
    C:reader(MemoryService,b.config.database,true,false),D:reader(MemoryService,d.config.database,true,true),
    E:reader(MemoryService,e.config.database,true,true)};
  for(const task of tasks) {
    const outcomes={id:task.id,split:task.split,category:task.category};
    for(const [arm,service] of Object.entries(arms)) {
      const modern=arm!=='A', state=(modern?modernRefs:legacyRefs).get(task.id);
      const start=performance.now(), result=await service.recall(request(task,modern,['C','D','E'].includes(arm)));
      const ms=performance.now()-start;
      assert.equal(result.retrieval_mode,'hybrid',task.id+'/'+arm);
      assert.equal(result.diagnostics.full_body_records_read,0,task.id+'/'+arm);
      assert.equal(new Set(result.items.map(item=>key({memory_id:item.id,revision:item.revision}))).size,result.items.length);
      outcomes[arm]={...score(task,state,result),ms,bytes:result.diagnostics.response_bytes,body_reads:0};
    }
    report.samples.push(outcomes);
  }
  const armsBySplit=['dev','test','all'].map(split=>{
    const slice=report.samples.filter(task=>split==='all'||task.split===split);
    const byCategory=Object.fromEntries([...categories,'all'].map(category=>{
      const list=slice.filter(task=>category==='all'||task.category===category);
      return [category,Object.fromEntries(Object.keys(arms).map(arm=>{
        const rows=list.map(task=>task[arm]),withAnswers=rows.filter(row=>row.raw_recall!==null);
        const avg=(values)=>values.length?values.reduce((sum,value)=>sum+Number(value),0)/values.length:null;
        return [arm,{n:rows.length,ok:rows.filter(row=>row.ok).length,answer:rows.filter(row=>row.answer).length,
          p1:avg(rows.map(row=>row.p1)),raw_recall:avg(withAnswers.map(row=>row.raw_recall)),
          provenance_recall:avg(withAnswers.map(row=>row.provenance_recall)),
          exclusions:rows.reduce((sum,row)=>sum+row.violation_count,0)}];
      }))];
    }));
    return [split,byCategory];
  });
  report.summary=Object.fromEntries(armsBySplit);
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({root,raw_evidence_hash:report.raw_evidence_hash,held_out:report.summary.test,
    learned:report.learned,derived:report.consolidated.length},null,2));
} finally {for(const service of services.reverse())service.close();}
