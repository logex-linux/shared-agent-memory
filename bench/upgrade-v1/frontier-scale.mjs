import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {copyFile,readdir,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {backup} from 'node:sqlite';
import {MemoryService} from '../../dist/core/service.js';
import {indexChunk} from '../../dist/retrieval/indexes.js';
import {recordHash} from '../../dist/memory/versions.js';
import {isolatedWorkspace,reportDirectory,writeRunReport} from '../../scripts/artifacts.mjs';

const project='c9e7f9c7-71ad-4df8-8ea0-d9e70e11d03c';
const model_dir=resolve('.local/models/bge-small-zh-v1.5');
const base={model_dir,allowed_projects:[project],operations:['recall'],context_pack_enabled:true,threads:2};
const query={query:'frontier-load-0 release artifact short header retry count',project_id:project,
  subject_id:'frontier-load-0',view:'evidence',limit:2};
const uri=`sam://projects/${project}/subjects/frontier-load-0/current`;
const now='2026-10-01T00:00:00.000Z';
const q=(times,p)=>[...times].sort((a,b)=>a-b)[Math.ceil(times.length*p)-1];
const charBytes=value=>Buffer.byteLength(JSON.stringify(value));
const sampling=(async operation=>{const start=performance.now();const result=await operation();return [performance.now()-start,result];});
const modes=['ordinary','catalog','task','pack'];
const arm=process.argv[2];

if(arm==='--worker'){
  const database=process.argv[3],client=process.argv[4];
  const service=new MemoryService({...base,database,connection_id:'frontier-scale:'+client});
  try {
    const [packCold,cold]=await sampling(()=>service.contextPack({read:query}));
    assert.equal(cold.retrieval_mode,'hybrid');
    const started=performance.now(),id=randomUUID();
    service.taskOverride({task_id:id,exclude_subjects:[{owner:{scope:'project',project_id:project},subject_id:'short header alias',context_key:'standard'}]});
    const admission_ms=performance.now()-started;
    const collected=Object.fromEntries(modes.map(mode=>[mode,[]]));let packBytes;
    for(let n=0;n<12;n++){
      const [a,r]=await sampling(()=>service.recall(query));assert.ok(r.items.length);collected.ordinary.push(a);
      const [b,catalog]=await sampling(()=>service.browse({uri,limit:2}));assert.equal(catalog.items.length,2);collected.catalog.push(b);
      const [c,excluded]=await sampling(()=>service.browse({uri,limit:2,task_id:id}));assert.equal(excluded.count,0);collected.task.push(c);
      const [d,evidence]=await sampling(()=>service.contextPack({read:query}));assert.equal(evidence.pack,'deterministic-v1');
      collected.pack.push(d);packBytes=charBytes(evidence);
    }
    console.log(JSON.stringify({client,pack_cold_ms:packCold,
      override_registration_ms:admission_ms,pack_bytes:packBytes,high_rss_bytes:process.resourceUsage().maxRSS*1024,collected}));
  } finally{service.close();}
}else{
  if(!arm)throw Error('Usage: frontier-scale.mjs REPORT_DIRECTORY');
  const root=await isolatedWorkspace('frontier-scale'),out=await reportDirectory(arm,'frontier-scale');
  const source=join(root,'source.db');
  const writer=new MemoryService({...base,database:source,operations:['recall','manage']});
  const workloads=[100,1000,10000],groups=24,seed=new Map(),fixtures=[];
  let model;
  try{
    await writer.project(project,'Synthetic scale project',root);
    const profile=await writer.encoder.profile();model=profile.id;
    writer.db.prepare('INSERT INTO embedding_profiles VALUES(?,?)').run(model,JSON.stringify(profile.manifest));
    for(let group=0;group<groups;group++){
      const subject=`frontier-load-${group}`,title=`${subject} release artifact`;
      const text=`For ${subject}, the release artifact keeps a short header and uses retry count ${group+4}. Check the owner before deploying.`;
      seed.set(group,{subject,title,text,chunks:await writer.encoder.chunks(title,text)});
    }
    const insert=writer.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    const chunk=writer.db.prepare('INSERT INTO memory_chunks(memory_id,revision,start,end,tokens,text,profile_id) VALUES(?,1,?,?,?,?,?)');
    const vector=writer.db.prepare('INSERT INTO memory_vec VALUES(?,?,?)');
    let created=0,first;
    for(const size of workloads){
      const started=performance.now();
      writer.storage.transaction(()=>{
        for(;created<size;created++){
          const {subject,title,text,chunks}=seed.get(created%groups),id=randomUUID();
          const record={project_id:project,scope:'project',title,content:text,kind:'fact',
            subject_id:subject,context_key:'standard',tags:['synthetic'],
            sources:[{source_type:'test',uri:`test://frontier-scale/${created}`,locator:'structured fixture',
              revision_ref:'scale-v1',checked_at:now}],
            verification:{status:'unverified',basis:'source_claim',method:'load test',summary:'Synthetic fixture'},
            valid_for:{},derived_from:[],author_client:'frontier-scale',author_session:'scale'};
          insert.run(id,project,'project',JSON.stringify(record),1,'active',now,now,model,recordHash(record),null,'frontier-scale');
          for(const c of chunks){
            const key=Number(chunk.run(id,c.start,c.end,c.tokens,c.text,model).lastInsertRowid);
            vector.run(BigInt(key),Buffer.from(c.vector.buffer,c.vector.byteOffset,c.vector.byteLength),project);
            indexChunk(writer.db,{id:key,memory_id:id,text:c.text},title,record.tags);
          }
          if(created===0)first={memory_id:id,revision:1,subject_id:subject,context_key:'standard',
            aliases:['short header alias'],start:0,end:text.length};
        }
        writer.storage.advance();
      });
      if(size===100){
        const classify={records:[first]},preview=writer.classify(classify);
        writer.classify({...classify,plan_hash:preview.plan_hash},true);
      }
      const path=join(root,size+'.db');
      await backup(writer.db,path);
      fixtures.push({size,path,ingestion_ms:performance.now()-started});
    }
  } finally{writer.close();}
  const entry=fileURLToPath(import.meta.url);
  const worker=(database,index)=>new Promise((choose,reject)=>{
    const child=spawn(process.execPath,[entry,'--worker',database,String(index)],{stdio:['ignore','pipe','pipe']});
    let output='',error='';
    child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>error+=data);
    const timer=setTimeout(()=>child.kill('SIGTERM'),90_000);
    child.on('error',reject);
    child.on('close',exit=>{
      clearTimeout(timer);
      if(exit!==0){reject(Error(error.slice(-2500)));return;}
      try {choose(JSON.parse(output));}catch(e){reject(e);}
    });
  });
  const files=async prefix=>Object.fromEntries(await Promise.all((await readdir(root))
    .filter(file=>file.startsWith(prefix)).map(async file=>[file,(await stat(join(root,file))).size])));
  const cells=[];
  for(const fixture of fixtures)for(const clients of [1,2,4,8]){
    const filename=`${fixture.size}-${clients}.db`,database=join(root,filename);
    await copyFile(fixture.path,database);
    const measured=await Promise.all(Array.from({length:clients},(_,index)=>worker(database,index)));
    const elapsed=Object.fromEntries(modes.map(mode=>[mode,q(measured.flatMap(r=>r.collected[mode]),.95)]));
    const report={records:fixture.size,clients,p95_ms:elapsed,override_p95_ms:q(measured.map(r=>r.override_registration_ms),.95),
      pack_cold_p95_ms:q(measured.map(r=>r.pack_cold_ms),.95),
      rss_worker_max_bytes:Math.max(...measured.map(r=>r.high_rss_bytes)),
      rss_sum_of_worker_peaks_bytes:measured.reduce((a,b)=>a+b.high_rss_bytes,0),disk_bytes:await files(filename),
      pack_reply_bytes:q(measured.map(r=>r.pack_bytes),.95)};
    if(clients===1){
      const service=new MemoryService({...base,database,operations:['manage']});
      try {
        const [maintenance]=await sampling(()=>service.maintenance());
        report.maintenance_ms=maintenance;report.seed_increment_ms=fixture.ingestion_ms;
      }finally{service.close();}
    }
    cells.push(report);
    await writeRunReport(root,{model,clients:'independent SQLite/MCP core processes',cells},{directory:out});
    console.log(JSON.stringify(report));
  }
  console.log(out);
}
