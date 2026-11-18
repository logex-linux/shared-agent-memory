import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {hash} from '../../dist/core/contracts.js';
import {MemoryService,readConfig} from '../../dist/core/service.js';
import {artifactHash} from '../../dist/storage/installation.js';
import {isolatedWorkspace,reportDirectory,writeRunReport} from '../../scripts/artifacts.mjs';
import {runAgent} from './agent-runner.mjs';
import {pilotCases} from './paired-fixtures.mjs';

const root=await isolatedWorkspace('paired-agents');
const [baseline,output,families]=process.argv.slice(2);
assert.ok(baseline&&output,'Usage: paired-agents.mjs BETA4_RUNTIME REPORT_DIRECTORY [FAMILY,...]');
const directory=await reportDirectory(output,'paired');
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const candidate=resolve(process.env.SAM_PAIRED_CANDIDATE??'.');
assert.equal((await json(join(baseline,'package.json'))).version,'1.0.0-beta.4');
const arms=[
  {name:'no_memory'},
  {name:'beta4_recall',runtime:resolve(baseline),primary:'memory_recall'},
  {name:'beta4_pack',runtime:resolve(baseline),primary:'memory_context_pack'},
  {name:'candidate_pack',runtime:candidate,primary:'memory_context_pack'}
];
const builds=Object.fromEntries(await Promise.all([...new Set(arms.flatMap(arm=>arm.runtime?[arm.runtime]:[]))]
  .map(async path=>[path,{version:(await json(join(path,'package.json'))).version,artifacts_sha256:await artifactHash(path)}])));
const clients=[
  {client:'codex',model:process.env.SAM_CODEX_MODEL??'gpt-6.2-sol'},
  {client:'stepcode',provider:process.env.SAM_STEP_PROVIDER??'magpie',model:process.env.SAM_STEP_MODEL??'minimax-code/MiniMax-M3.1-Flash'}
].filter(spec=>!process.env.SAM_PAIRED_CLIENT||spec.client===process.env.SAM_PAIRED_CLIENT);
assert.ok(clients.length);
const caseSchema=z.object({
  family:z.string().regex(/^[a-z0-9-]{1,40}$/),split:z.enum(['development','pilot','holdout']),
  kind:z.enum(['current','override','scope','forgotten','history','conflict','missing','procedure','pagination']),
  topic:z.string().min(1).max(80),question:z.string().min(1).max(500),
  marker:z.string().regex(/^[A-Z0-9_-]{1,60}$/).optional(),override:z.string().regex(/^[A-Z0-9_-]{1,60}$/).optional()
}).strict().refine(c=>c.kind!=='override'||Boolean(c.override));
const caseFile=process.env.SAM_PAIRED_CASES;
const frozen=z.array(caseSchema).min(1).max(500).parse(caseFile?await json(caseFile):pilotCases);
assert.equal(new Set(frozen.map(c=>c.family)).size,frozen.length,'Use one scenario per independent source family');
const cases=families?frozen.filter(c=>families.split(',').includes(c.family)):frozen;
assert.ok(cases.length);
const budget={page_item_limit:5,response_token_budget:1400,page_response_bytes:4200};
const timeoutMs=Number(process.env.SAM_PAIRED_TIMEOUT_MS??60000);
assert.ok(Number.isSafeInteger(timeoutMs)&&timeoutMs>=10000);
const sourceModel=resolve('.local/models/bge-small-zh-v1.5');
const ref=row=>({memory_id:row.memory_id,revision:row.revision});
const key=row=>[row.memory_id??row.id,row.revision].join(':');
const review='REVIEW';
const quantile=(values,q)=>values.length?[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(q*values.length)-1)]:null;
const total=values=>values.reduce((a,b)=>a+b,0);
const ratio=(n,d)=>d?n/d:null;

async function freeze(c) {
  const folder=join(root,'source-'+c.family),work=join(folder,'project'),other=join(folder,'other');
  await mkdir(work,{recursive:true});await mkdir(other);
  const project=randomUUID(),foreign=randomUUID(),database=join(folder,'fixture.db'),found=join(folder,'source.md');
  const marker=c.marker??'MARK-'+hash('current/'+c.family).slice(0,9).toUpperCase();
  const stale='OLD-'+hash('historical/'+c.family).slice(0,9).toUpperCase();
  const gold={expected:marker,targets:[],obsolete:[],forbidden:[]};
  const config={database,model_dir:sourceModel,allow_global:false,allowed_projects:[project],
    connection_id:'paired-evaluation',operations:['recall'],...budget};
  const writer=new MemoryService({...config,connection_id:'fixture-author',allowed_projects:[project,foreign],
    operations:['recall','manage','propose','commit','forget']});
  const text=c.topic+'发布及交接操作记录。发布标记为 '+marker+'。';
  const document='# '+c.topic+'\n'+text+'\n';
  if(c.kind!=='missing')await writeFile(found,document,{mode:0o600});
  const source={source_type:'document',uri:found,locator:'line 2',revision_ref:'sha256:'+hash(document),
    checked_at:'2026-01-01T00:00:00.000Z',source_hash:hash(document)};
  const base={project_id:project,scope:'project',kind:c.kind==='procedure'?'procedure':'fact',title:c.topic,
    content:text,subject_id:'private-label.'+hash(c.family).slice(0,12),context_key:'standard',sources:[source],
    verification:{method:'Synthetic fixture review',summary:'Independent source family for paired evaluation.'},
    author_client:'paired-fixture',author_session:'pilot'};
  const publish=async(record,fields={})=>{
    const proposal=await writer.propose({request_id:randomUUID(),record,...fields});
    return writer.commit({request_id:randomUUID(),proposal_id:proposal.proposal_id,expected_revision:proposal.expected_revision});
  };
  try {
    await writer.project(project,'Task project',work);
    await writer.project(foreign,'Unrelated project',other);
    if(c.kind==='scope'){
      const row=await publish({...base,project_id:foreign});
      gold.forbidden.push(ref(row));gold.expected=review;
    }else if(c.kind==='forgotten'){
      const row=await publish(base);
      const request={memory_id:row.memory_id,expected_revision:row.revision};
      assert.equal((await writer.forget({...request,request_id:randomUUID(),plan_hash:writer.forgetPreview(request).plan_hash})).forgotten,true);
      gold.forbidden.push(ref(row));gold.expected=review;
    }else if(c.kind==='history'){
      const earlier=await publish({...base,content:text.replace(marker,stale),lifecycle:'historical',
        valid_time:{valid_from:'2025-01-01T00:00:00.000Z',valid_to:'2025-07-01T00:00:00.000Z'}});
      const later=await publish({...base,valid_time:{valid_from:'2025-07-01T00:00:00.000Z',valid_to:'2027-01-01T00:00:00.000Z'}});
      gold.targets.push(ref(earlier));gold.obsolete.push(ref(later));gold.expected=stale;
    }else if(c.kind==='conflict'){
      const first=await publish(base);
      const second=await publish({...base,content:text.replace(marker,stale)},{expected_refs:[ref(first)],
        relations:[{target_id:first.memory_id,type:'contradicts',sources:[source]}]});
      gold.targets.push(ref(first),ref(second));gold.expected=review;
    }else {
      const older=await publish({...base,content:text.replace(marker,stale)+(c.kind==='procedure'?' 旧版工具使用第一种发送参数。':'')});
      const latest=await publish({...base,content:text+(c.kind==='procedure'?' 仅适用当前发布接口。以写入结果为准。':'')},
        {target_id:older.memory_id,expected_revision:older.revision});
      gold.targets.push(ref(latest));gold.obsolete.push(ref(older));
      if(c.kind==='override')gold.expected=c.override;
      if(c.kind==='missing')gold.expected=review;
      if(c.kind==='pagination'){
        for(let i=0;i<8;i++)await publish({...base,subject_id:undefined,title:c.topic+' 附表 '+i,
          content:c.topic+' 附表 '+i+' 记录零件数和试印步骤。该附表不包含最终发布标记。'});
      }
    }
    writer.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  } finally {writer.close();}
  return {database,config,gold,sha256:hash(await readFile(database))};
}

function positions(db,response,project,catalog) {
  const lookup=db.prepare(`SELECT v.body,s.status,s.project_id FROM memory_version_bodies v JOIN memory_search s USING(memory_id)
    WHERE v.memory_id=? AND v.revision=?`);
  const items=(response?.items??[]).filter(item=>!catalog||item.span);
  return items.map(item=>{
    const memory_id=item.memory_id??item.id,revision=item.revision;
    const row=lookup.get(memory_id,revision);
    const body=row?.body?JSON.parse(row.body):null;
    const inline=Array.isArray(item.spans)?item.spans:item.span?[item.span]:undefined;
    const spans=(inline??item.excerpts??[]).map(({start,end,text})=>
      ({start,end,text:inline?text:body?.content.slice(start,end)}));
    const readable=row?.status==='active'&&row?.project_id===project;
    const verified=Boolean(readable&&body&&spans.length&&spans.every(({start,end,text})=>
      Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&end>start&&end<=body.content.length&&
      text===body.content.slice(start,end))&&(inline||spans.map(span=>span.text).join('\n…\n')===item.content));
    return {memory_id,revision,spans,verified,readable,use:item.use??item.applicability};
  });
}

async function diagnostic(config,requests,wanted,finding) {
  const scoped=new MemoryService(await readConfig(config));
  try {
    for(const read of requests.filter(request=>request?.query).slice(0,2)){
      let page=await scoped.recall({...read,view:'evidence'});
      for(let number=1;number<=3;number++){
        const match=page.items.some(item=>wanted.has(key(item)));
        if(match)return {reachable:true,page:number,classification:number>finding?'pagination':'packing'};
        if(!page.next_cursor)break;
        page=await scoped.recall({cursor:page.next_cursor});
      }
    }
    return {reachable:false,classification:'retrieval'};
  }catch(error){return {reachable:null,error:error.code??error.name,classification:'unclassified'};}
  finally{scoped.close();}
}

const prepared=new Map();
async function task(c,spec,arm,order) {
  let frozen=prepared.get(c.family);
  if(!frozen)prepared.set(c.family,frozen=freeze(c));
  const snapshot=await frozen;
  const folder=join(root,[c.family,spec.client,arm.name].join('-')),work=join(folder,'project');
  await mkdir(work,{recursive:true});
  const database=join(folder,'fixture.db'),config=join(folder,'config.json');
  await copyFile(snapshot.database,database);
  assert.equal(hash(await readFile(database)),snapshot.sha256);
  const pack=arm.primary==='memory_context_pack';
  await writeFile(config,JSON.stringify({...snapshot.config,database,context_pack_enabled:pack}),{mode:0o600});
  const prompt='请完成这个工作事项，并调用 write_fixture_result 写入最终的发布标记。value 只填标记本身。'
    +'有适用的工作记录明确给出标记时，按记录填写。找不到标记、当前说法冲突或题目要求的来源缺失时写 REVIEW。'
    +'可以使用已提供的记忆工具核对当前项目。\n'+c.question;
  const tools=arm.primary?[arm.primary,'memory_inspect','memory_explain','memory_browse']:[];
  const run=await runAgent({...spec,work,config:arm.runtime?config:undefined,server:arm.runtime&&join(arm.runtime,'dist/mcp/server.js'),
    tools,prompt,paired:true,timeoutMs});
  const artifact=await readFile(join(work,'fixture-result.txt'),'utf8').catch(error=>{
    if(error.code==='ENOENT')return null;
    throw error;
  });
  const db=new DatabaseSync(database,{readOnly:true});
  const {gold}=snapshot,wanted=new Set(gold.targets.map(key)),old=new Set(gold.obsolete.map(key));
  let calls;
  try {
    calls=run.trace.map(({name,args,ok,response,reply_bytes,elapsed_ms})=>({name,args,ok,reply_bytes,elapsed_ms,
      ...(name?.startsWith('memory_')&&{response_decoded:Boolean(response),has_more:response?.has_more??false,
        evidence_status:response?.evidence_status,warnings:response?.warnings,
        evidence:positions(db,response,snapshot.config.allowed_projects[0],name==='memory_browse')})}));
  } finally {db.close();}
  const shown=calls.flatMap(call=>call.evidence??[]),primary=calls.filter(call=>call.name===arm.primary);
  const top=primary[0]?.evidence?.slice(0,5)??[];
  const retrieved=shown.some(item=>wanted.has(key(item))),obsolete=top.some(item=>old.has(key(item)));
  const unauthorized=shown.some(item=>!item.readable||gold.forbidden.some(ref=>key(ref)===key(item)));
  const exact_spans=shown.every(item=>item.verified);
  const action=calls.some(call=>call.name?.endsWith('write_fixture_result')&&call.ok);
  const passed=run.code===0&&artifact===gold.expected&&action&&!unauthorized&&exact_spans;
  const used=run.usage.map(row=>row.input_tokens);
  const inputTokens=used.length&&used.every(value=>value!==null)&&total(used)>0?total(used):null;
  const unavailable=run.code!==0&&inputTokens===null&&!calls.length;
  let failure=null;
  if(!passed){
    if(unavailable)failure='client_unavailable';
    else if(run.code!==0)failure='client';
    else if(unauthorized)failure='scope';
    else if(!exact_spans)failure='evidence_offsets';
    else if(!action||run.last?.includes(gold.expected)&&artifact!==gold.expected)failure='action';
    else if(wanted.size&&!retrieved&&arm.primary&&gold.expected!==review&&c.kind!=='override'){
      const diagnosis=await diagnostic(config,primary.map(call=>pack?call.args.read:call.args),wanted,primary.length);
      failure=diagnosis.classification;
    }else failure='decision';
  }
  const bytes=calls.filter(call=>call.name?.startsWith('memory_')).map(call=>call.reply_bytes);
  const observedModels=[...new Set(run.usage.map(row=>row.model).filter(Boolean))];
  const model_matched=!observedModels.length||observedModels.every(id=>id===spec.model);
  return {family:c.family,split:c.split,kind:c.kind,client:spec.client,model:spec.model,observed_models:observedModels,model_matched,
    arm:arm.name,order,snapshot:snapshot.sha256,passed:passed&&model_matched,scorable:!unavailable&&model_matched,
    failure:model_matched?failure:'model_mismatch',
    expected:gold.expected,artifact,tool_state:{artifact_exists:artifact!==null,write_succeeded:action},exit_code:run.code,
    target_at_5:gold.expected!==review&&c.kind!=='override'?top.some(item=>wanted.has(key(item))):null,
    current_at_5:gold.expected!==review&&!['override','history'].includes(c.kind)?top.some(item=>wanted.has(key(item))):null,
    contamination_at_5:old.size>0&&gold.expected!==review&&!['override','history'].includes(c.kind)?
      obsolete&&top.some(item=>wanted.has(key(item))):null,
    missing_source_definite:c.kind==='missing'?artifact!==null&&artifact!==review:null,
    exact_spans,unauthorized,continuations:primary.filter(call=>(pack?call.args.read:call.args)?.cursor).length,calls,
    tool_reply_bytes:bytes.every(value=>value!==null)?total(bytes):null,
    input_tokens:inputTokens,usage:run.usage,elapsed_ms:run.elapsed_ms,
    ...(run.errors.length>0&&{errors:run.errors.slice(-2)}),...(run.tool_errors.length>0&&{tool_errors:run.tool_errors}),
    ...(run.stderr.length>0&&{stderr:run.stderr})};
}

function summarize(rows) {
  const holdout=rows.filter(row=>row.split==='holdout'),scheduled=holdout.length?holdout:rows;
  const scored=scheduled.filter(row=>row.scorable);
  const metrics=Object.fromEntries(arms.map(({name})=>{
    const runs=scored.filter(row=>row.arm===name);
    const measured=runs.filter(row=>row.input_tokens!==null);
    const proportion=field=>ratio(runs.filter(row=>row[field]===true).length,runs.filter(row=>row[field]!==null).length);
    return [name,{attempts:scheduled.filter(row=>row.arm===name).length,runs:runs.length,
      successes:runs.filter(row=>row.passed).length,input_token_runs:measured.length,
      input_tokens_p50:quantile(measured.map(row=>row.input_tokens),.5),
      tool_reply_bytes_p50:quantile(runs.flatMap(row=>row.tool_reply_bytes===null?[]:[row.tool_reply_bytes]),.5),
      elapsed_ms_p95:quantile(runs.map(row=>row.elapsed_ms),.95),current_at_5:proportion('current_at_5'),
      contamination_at_5:proportion('contamination_at_5'),missing_source_definite:proportion('missing_source_definite')}];
  }));
  const controls=scored.filter(row=>row.arm==='beta4_recall'),candidate=scored.filter(row=>row.arm==='candidate_pack');
  const pairs=controls.flatMap(baseline=>{
    const sample=candidate.find(row=>row.family===baseline.family&&row.client===baseline.client);
    const none=scored.find(row=>row.arm==='no_memory'&&row.family===baseline.family&&row.client===baseline.client);
    return sample?[{baseline,sample,none}]:[];
  });
  const groups=[...new Set(pairs.map(p=>p.sample.family))].map(family=>pairs.filter(p=>p.sample.family===family));
  const deltas=groups.map(group=>total(group.map(({baseline,sample})=>Number(sample.passed)-Number(baseline.passed)))/group.length);
  let seed=20261118;
  const sample=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return deltas[Math.floor(seed/4294967296*deltas.length)];};
  const draws=deltas.length?Array.from({length:10000},()=>total(deltas.map(sample))/deltas.length):[];
  const bound=groups.length&&pairs.every(({baseline,sample})=>baseline.passed===sample.passed)?1-Math.pow(.05,1/groups.length):null;
  const cost=pairs.filter(({baseline,sample})=>baseline.input_tokens!==null&&sample.input_tokens!==null);
  const median={baseline:quantile(cost.map(({baseline})=>baseline.input_tokens),.5),
    candidate:quantile(cost.map(({sample})=>sample.input_tokens),.5)};
  const reduction=median.baseline?1-median.candidate/median.baseline:null;
  const withNone=pairs.filter(p=>p.none);
  const critical_failures=candidate.filter(row=>!row.exact_spans||row.unauthorized||
    ['override','scope','forgotten'].includes(row.kind)&&!row.passed).length;
  const interval=[quantile(draws,.025),quantile(draws,.975)],delta=ratio(total(deltas),deltas.length);
  return {scored_split:holdout.length?'holdout':'pilot',metrics,paired:{tasks:pairs.length,families:groups.length,
    delta,family_bootstrap_95:interval,
    zero_discordance_family_upper_95:bound,cost_pairs:cost.length,median_input_tokens:median,reduction,
    no_memory_success_memory_failure:ratio(withNone.filter(p=>p.none.passed&&!p.sample.passed).length,withNone.length),
    no_memory_failure_memory_success:ratio(withNone.filter(p=>!p.none.passed&&p.sample.passed).length,withNone.length)},
    unscored_runs:scheduled.length-scored.length,critical_failures,
    criteria:{holdout_available:holdout.length>0,noninferiority:interval[0]!==null&&interval[0]>-.02&&
      (bound===null||bound<.02),input_token_reduction:cost.length===pairs.length&&reduction!==null&&reduction>=.2,
      fixed_budget_success_gain:delta!==null&&delta>=.05&&interval[0]>0}};
}

const rows=[];
const settings={builds,clients,budget,timeout_ms:timeoutMs,fixture_sha256:hash(frozen),fixture_kind:caseFile?'operator_supplied':'synthetic',
  input_token_methods:{codex:'turn.completed usage totals',stepcode:'assistant message usage, including cache reads and writes'}};
const planned=cases.length*clients.length*arms.length;
async function save(){
  await writeRunReport(root,{...settings,partial:rows.length!==planned,rows,
    by_client:Object.fromEntries(clients.map(({client})=>[client,summarize(rows.filter(row=>row.client===client))])),
    combined:summarize(rows)},{directory});
}
let reportWrite=Promise.resolve();
const runFamily=async(c,spec,index)=>{
  const position=(index*(spec.client==='codex'?1:3)+(spec.client==='codex'?0:2))%arms.length;
  const order=arms.slice(position).concat(arms.slice(0,position));
  for(const [i,arm] of order.entries()){
    const row=await task(c,spec,arm,i);
    rows.push(row);
    console.log(JSON.stringify({family:row.family,client:row.client,arm:row.arm,passed:row.passed,
      failure:row.failure,tokens:row.input_tokens,tool_calls:row.calls.length,elapsed_ms:Math.round(row.elapsed_ms)}));
    reportWrite=reportWrite.then(save);
    await reportWrite;
  }
};
await Promise.all(clients.map(async spec=>{
  let next=0;
  await Promise.all(Array.from({length:Math.min(3,cases.length)},async()=>{
    while(next<cases.length){
      const index=next++;
      try {await runFamily(cases[index],spec,index);}
      catch(error){console.error(error);process.exitCode=1;}
    }
  }));
}));
await reportWrite;
console.log(JSON.stringify({report:join(directory,'report.json'),cases:cases.length,runs:rows.length,combined:summarize(rows)}));
