import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp,readFile,realpath,stat,writeFile,copyFile } from 'node:fs/promises';
import { dirname,join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MemoryService } from '../../dist/core/service.js';
import { BgeEncoder } from '../../dist/embedding/bge.js';

const [out,corpora,baseline,sizeFilter,clientFilter]=process.argv.slice(2);
if(!out||!corpora||!baseline)throw Error('Usage: scale-matrix.mjs OUTPUT SCALE_CORPORA BASELINE_DIST [SIZE] [CLIENTS]');
const root=await mkdtemp(join(await realpath(out),'scale-matrix-'));
const kernels={A:resolve(baseline),B:resolve('dist'),C:resolve('dist')};
const {MemoryService:Legacy}=await import(pathToFileURL(join(kernels.A,'core/service.js')));
const model_dir=resolve('.local/models/bge-small-zh-v1.5');
const encoder=new BgeEncoder({model_dir,dtype:'fp32',threads:2});
const cases=JSON.parse(await readFile('bench/cases.json','utf8'));
const gold=JSON.parse(await readFile(join(corpora,'gold.json'),'utf8'));
const project='12345678-1234-4234-8234-123456789abc';
const sizes=sizeFilter?[Number(sizeFilter)]:[100,1000,10000];
const clientCounts=clientFilter?[Number(clientFilter)]:[1,2,4,8];
const fixedOrder=process.env.SAM_MATRIX_ORDER?.split(',');
if(fixedOrder)assert.deepEqual([...fixedOrder].sort(),['A','B','C']);
const stats={model:(await encoder.profile()).id,corpora:{},cells:[],fixed_order:fixedOrder};
const config={model_dir,dtype:'fp32',threads:2,allowed_projects:[project],allow_global:false,
  operations:['recall'],connection_id:'scale-matrix-reader',cache_max_bytes:268435456,cache_disk_max_bytes:1073741824};
const edgeSources=JSON.stringify([{source_type:'test',uri:'test://v1/scale/edge-ring',locator:'synthetic load edge',
  revision_ref:'scale-matrix-v1',checked_at:'2026-06-01T00:00:00.000Z'}]);
const quantile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]??null;
const digest=async path=>{
  const h=createHash('sha256');
  for await(const data of createReadStream(path))h.update(data);
  return h.digest('hex');
};
const snapshotSize=async database=>Object.fromEntries(await Promise.all(
  ['','-wal','-shm','.retrieval.db','.retrieval.db-wal','.retrieval.db-shm'].map(async suffix=>{
    try{return [suffix||'canonical',(await stat(database+suffix)).size];}
    catch(e){if(e.code!=='ENOENT')throw e;return [suffix||'canonical',0];}
  })));
function open(Service,dbConfig,shared) {
  assert.equal(dirname(dbConfig.database),root);
  return new Service(dbConfig,shared);
}
async function prepare(size,arm,count) {
  const src=join(corpora,size+'.db');
  const database=join(root,[size,count,arm].join('-')+'.db');
  await copyFile(src,database);
  const dbConfig={...config,database,...(arm!=='A'&&{graph_enabled:arm==='C'})};
  const started=performance.now();
  const service=open(arm==='A'?Legacy:MemoryService,dbConfig,encoder);
  try{
    assert.equal(service.db.prepare('SELECT count(*) n FROM memories').get().n,size);
    if(arm==='C'){
      const insert=service.db.prepare('INSERT INTO memory_relations VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      const version=service.db.prepare('SELECT revision,project_id FROM memories WHERE id=?');
      service.storage.transaction(()=>{
        for(let i=0;i<gold.length;i++){
          const left=version.get(gold[i]),right=version.get(gold[(i+1)%gold.length]);
          assert.equal(left.project_id,project);
          assert.equal(right.project_id,project);
          insert.run(randomUUID(),1,gold[i],left.revision,gold[(i+1)%gold.length],right.revision,'related_to',
            project,'project',edgeSources,'2026-06-01T00:00:00.000Z');
        }
        service.db.exec("UPDATE meta SET value=value+1 WHERE key='graph_epoch'");
      });
    }
    return {dbConfig,prepare_ms:performance.now()-started};
  }finally{service.close();}
}
function observe(stream,id,state) {
  let buffer='';
  stream.on('data',data=>{
    buffer+=data;
    for(let i=buffer.indexOf('\n');i>=0;i=buffer.indexOf('\n')){
      const line=buffer.slice(0,i);
      buffer=buffer.slice(i+1);
      try{
        const {sam_probe:sample}=JSON.parse(line);
        if(!sample)continue;
        state.latest.set(id,sample);
        const previous=state.processes[id];
        state.processes[id]={pid:sample.pid,peak_rss_bytes:Math.max(previous?.peak_rss_bytes??0,sample.memory.rss),
          latest_heap_bytes:sample.memory.heapUsed,latest_external_bytes:sample.memory.external,
          latest_cpu_us:sample.cpu.user+sample.cpu.system};
        const points=[...state.latest.values()];
        if(points.length===state.count&&points.every(point=>sample.time-point.time<=400)){
          const rss=points.reduce((sum,point)=>sum+point.memory.rss,0);
          state.peak=Math.max(state.peak??0,rss);
        }
      }catch{}
    }
  });
}
const initialRequest=(query,arm,extras={})=>({query,project_id:project,mode:'focused',view:'evidence',limit:5,debug:true,
  ...(arm==='C'&&{graph:true}),...extras});
async function projectProbe(dbConfig) {
  const reader=open(MemoryService,dbConfig,encoder);
  const trainer=open(MemoryService,{...dbConfig,connection_id:'scale-matrix-feedback',operations:['recall','feedback','manage'],
    all_projects:true,allow_global:true,feedback_policy:'trusted_outcomes'},encoder);
  try {
    const query=cases[0][2];
    const readerPage=await reader.recall(initialRequest(query,'C',{mode:'broad',limit:1,debug:false}));
    const page=await trainer.recall(initialRequest(query,'B',{mode:'broad',limit:8,debug:false}));
    if(page.items.length<2||!readerPage.next_cursor)return {unavailable:'fixture did not return two current items and a continuation'};
    const used=page.items.slice(0,2).map(item=>({memory_id:item.id,revision:item.revision}));
    const started=performance.now();
    const feedback=await trainer.feedback({request_id:randomUUID(),task_id:randomUUID(),page_receipt:page.feedback_receipt,
      used,outcome:'useful',basis:'test_result',evidence_ref:'test://v1/scale/synthetic-outcome'});
    const queued=performance.now();
    const result=trainer.projectFeedback();
    const projected=performance.now();
    assert.equal(feedback.weight_eligible,true);
    assert.equal(result.changed_edges,1);
    let restart=null;
    try{await reader.recall({cursor:readerPage.next_cursor});}
    catch(error){restart=error.code;}
    assert.equal(restart,'CURSOR_GRAPH_CHANGED');
    const restarted=await reader.recall(initialRequest(query,'C',{mode:'broad',limit:1,debug:false}));
    assert.ok(restarted.items.length);
    return {enqueue_ms:queued-started,projection_ms:projected-queued,enqueue_to_visible_ms:projected-started,
      restart,watermark:result.watermark};
  }finally{trainer.close();reader.close();}
}
async function cell(size,count,arm){
  const {dbConfig,prepare_ms}=await prepare(size,arm,count);
  const {database}=dbConfig;
  const before=await snapshotSize(database);
  const paths=Array.from({length:count},(_,i)=>join(root,[size,count,arm,i].join('-')+'.json'));
  await Promise.all(paths.map(path=>writeFile(path,JSON.stringify(dbConfig),{mode:0o600})));
  const state={count,latest:new Map(),processes:{},peak:null};
  const clients=[];
  const samples=[];
  const failures=[];
  const connect=async(path,i)=>{
    const transport=new StdioClientTransport({command:process.execPath,args:[
      '--import',resolve('bench/performance/runtime-probe.mjs'),join(kernels[arm],'mcp/server.js')
    ],env:{SHARED_MEMORY_CONFIG:path},stderr:'pipe'});
    const client=new Client({name:'v1-scale-'+i,version:'1'});
    clients.push(client);
    observe(transport.stderr,i,state);
    await client.connect(transport);
    return client;
  };
  const call=async(client,request,phase,round=null,number=null)=>{
    const start=performance.now();
    let result,retries=0;
    for(;;){
      const reply=await client.callTool({name:'memory_recall',arguments:request},undefined,{timeout:120000});
      result=JSON.parse(reply.content[0].text);
      if(!reply.isError)break;
      if(result.error?.code==='BUSY_RETRYABLE'&&retries++<4)continue;
      failures.push({phase,round,number,error:result.error?.code});
      throw Error(JSON.stringify(failures.at(-1)));
    }
    const ms=performance.now()-start;
    assert.equal(result.retrieval_mode,'hybrid');
    assert.equal(result.diagnostics.full_body_records_read,0);
    const ids=result.items.map(item=>item.id);
    assert.equal(new Set(ids).size,ids.length);
    const metric=result.diagnostics;
    samples.push({phase,round,case:number,ms,retries,p1:number===null?null:ids[0]===gold[number],
      recall5:number===null?null:ids.includes(gold[number]),ids,bytes:metric.response_bytes,body_reads:metric.full_body_records_read,
      graph_rows:metric.graph_rows_examined??0,lock:metric.state_lock??null,rss_bytes:metric.memory?.rss??null});
    return result;
  };
  let cold,after,replayTrials=0;
  try {
    const started=performance.now();
    const connected=await Promise.all(paths.map(connect));
    await Promise.all(connected.map(client=>call(client,initialRequest(cases[0][2],arm),'cold',null,0)));
    cold=performance.now()-started;
    for(let round=0;round<3;round++){
      for(let step=0;step<12;step++){
        await Promise.all(connected.map((client,i)=>{
          const number=(step+round*5+i)%cases.length;
          return call(client,initialRequest(cases[number][2],arm),'warm',round,number);
        }));
      }
    }
    const first=await call(connected[0],initialRequest(cases[0][2],arm,{mode:'broad',limit:1}),'cursor-seed');
    assert.ok(first.next_cursor);
    const next=await Promise.all(connected.map(client=>call(client,{cursor:first.next_cursor,debug:true},'cursor-replay')));
    assert.ok(next.every(page=>JSON.stringify(page.items)===JSON.stringify(next[0].items)&&page.next_cursor===next[0].next_cursor));
    assert.ok(next[0].items.every(item=>item.id!==first.items[0]?.id));
    replayTrials=next.length;
    after=await snapshotSize(database);
  }finally{await Promise.allSettled(clients.map(client=>client.close()));}
  const projection=arm==='C'?await projectProbe(dbConfig):null;
  const warm=samples.filter(sample=>sample.phase==='warm');
  const summary=Object.fromEntries([0,1,2].map(round=>{
    const rows=warm.filter(sample=>sample.round===round);
    const lock=rows.flatMap(sample=>sample.lock?[sample.lock]:[]);
    return [round,{queries:rows.length,p50_ms:quantile(rows.map(s=>s.ms),.5),p95_ms:quantile(rows.map(s=>s.ms),.95),
      lock_wait_p95_ms:quantile(lock.map(s=>s.wait_ms),.95),lock_held_p95_ms:quantile(lock.map(s=>s.held_ms),.95),
      p1:rows.filter(s=>s.p1).length/rows.length,recall5:rows.filter(s=>s.recall5).length/rows.length,
      graph_rows:rows.reduce((sum,row)=>sum+row.graph_rows,0),retries:rows.reduce((sum,row)=>sum+row.retries,0)}];
  }));
  return {size,clients:count,arm,prepare_ms,cold_ms:cold,summary,before,after,closed:await snapshotSize(database),
    processes:state.processes,concurrent_sampled_rss_bytes:state.peak,replay_trials:replayTrials,projection,samples,failures};
}
for(const size of sizes){
  const path=join(corpora,size+'.db');
  stats.corpora[size]={bytes:(await stat(path)).size,sha256:await digest(path)};
  for(const count of clientCounts){
    const arms=['A','B','C'];
    const offset=(sizes.indexOf(size)+clientCounts.indexOf(count))%arms.length;
    for(const arm of fixedOrder??[...arms.slice(offset),...arms.slice(0,offset)]){
      const result=await cell(size,count,arm);
      stats.cells.push(result);
      await writeFile(join(root,'report.json'),JSON.stringify(stats,null,2),{mode:0o600});
      console.log(JSON.stringify({root,size,clients:count,arm,cold_ms:result.cold_ms,rounds:result.summary,
        projection:result.projection,concurrent_sampled_rss_bytes:result.concurrent_sampled_rss_bytes}));
    }
  }
}
