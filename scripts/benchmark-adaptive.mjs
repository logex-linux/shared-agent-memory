// Real BGE, frozen multi-answer evaluation. Generated artifacts stay outside Git.
import {readFile,writeFile,mkdir,copyFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';import {backup} from 'node:sqlite';
const {projects,memories,queries,fingerprint}=await import(pathToFileURL(resolve(process.env.BENCH_FIXTURE??'bench/adaptive/fixtures.mjs')));
const [command='build',directory='.local/adaptive/eval',kernelArg='dist']=process.argv.slice(2),dir=resolve(directory),kernel=resolve(kernelArg);
const {MemoryService}=await import(pathToFileURL(join(kernel,'core/service.js'))),modern=process.env.BENCH_LEGACY!=='1';
const config=database=>({database,model_dir:resolve('.local/models/bge-small-zh-v1.5'),allowed_projects:projects,allow_global:true,all_projects:false,operations:['recall','manage'],semantic_threshold:.425,evidence_threshold:.575,dtype:'fp32',threads:2});
const uuid=key=>{const h=createHash('sha256').update(key).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
await mkdir(dir,{recursive:true});
if(command==='build'){
 const {indexChunk}=await import(pathToFileURL(join(kernel,'retrieval/indexes.js'))),s=new MemoryService(config(join(dir,'build.db')));
 try{
  if(s.db.prepare('SELECT count(*) n FROM memories').get().n)throw Error('Build target must be empty');
  for(const [i,id]of projects.entries()){const alias=join(dir,'project-'+i);await mkdir(alias,{recursive:true});await s.project(id,'fictional-project-'+i,alias);}
  const profile=await s.encoder.profile();s.db.prepare('INSERT OR IGNORE INTO embedding_profiles VALUES(?,?)').run(profile.id,JSON.stringify(profile.manifest));
  for(const [i,m]of memories.entries()){
   const body={project_id:m.project,scope:'project',kind:m.kind,title:m.title,content:m.content,tags:m.tags,sources:[{source_type:m.basis==='user_confirmation'?'user':m.basis==='code_review'?'code':'document',uri:`test://fictional/project-${projects.indexOf(m.project)}/${m.key}`,locator:'scenario '+m.key,revision_ref:'frozen-v1',checked_at:m.date}],verification:{method:'fictional auditable fixture',summary:'Evidence type is explicit; not real user history',status:'unverified',basis:m.basis},valid_for:m.valid_for??{},author_client:'evaluation',author_session:'frozen',derived_from:[]};
   const chunks=await s.encoder.chunks(body.title,body.content),id=uuid(m.key);
   s.storage.transaction(()=>{
    s.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,m.project,'project',JSON.stringify(body),1,'active',m.date,m.date,profile.id,createHash('sha256').update(JSON.stringify(body)).digest('hex'),null,'fixture');
    for(const chunk of chunks){const row=s.db.prepare('INSERT INTO memory_chunks(memory_id,revision,start,end,tokens,text,profile_id) VALUES(?,1,?,?,?,?,?)').run(id,chunk.start,chunk.end,chunk.tokens,chunk.text,profile.id);s.db.prepare('INSERT INTO memory_vec VALUES(?,?,?)').run(BigInt(row.lastInsertRowid),Buffer.from(chunk.vector.buffer),m.project);indexChunk(s.db,{id:Number(row.lastInsertRowid),memory_id:id,text:chunk.text},body.title,body.tags);}
    s.db.prepare('INSERT INTO memories_fts VALUES(?,?)').run(id,body.title+' '+body.content);s.storage.advance();
   });
   if(i%60===0)console.log(JSON.stringify({built:i,target:memories.length}));
  }
  await backup(s.db,join(dir,'corpus.db'));await writeFile(join(dir,'manifest.json'),JSON.stringify({fingerprint,records:memories.length,queries:queries.length}));console.log(JSON.stringify({built:memories.length,queries:queries.length,fingerprint}));
 }finally{s.close();}
}else if(command==='measure'){
 const label=process.env.BENCH_LABEL??(modern?'0.4.1':'0.3.0'),database=join(dir,label+'.db');await rm(database,{force:true});await rm(database+'.retrieval.db',{force:true});await copyFile(join(dir,'corpus.db'),database);
 if(JSON.parse(await readFile(join(dir,'manifest.json'))).fingerprint!==fingerprint)throw Error('Fixture drift');
 const s=new MemoryService(config(database)),samples=[];let stats=null;const prepare=s.db.prepare.bind(s.db),parse=JSON.parse;
 s.db.prepare=function(sql){const st=prepare(sql);for(const name of ['get','all']){const call=st[name].bind(st);st[name]=(...args)=>{const r=call(...args);if(stats){for(const row of name==='all'?r:r?[r]:[]){if(typeof row.body==='string')stats.bodies++;if(typeof row.text==='string')stats.chunks++;}if(sql.includes('embedding MATCH')){stats.vector_queries++;stats.vector_rows+=r.length;}}return r;};}return st;};
 JSON.parse=function(...args){if(stats)stats.parses++;return parse(...args);};
 const rankMetrics=(ids,labels,k)=>{const hit=ids.slice(0,k).filter(id=>labels.has(id)).length,n=labels.size;let dcg=0;for(const [i,id]of ids.slice(0,k).entries())if(labels.has(id))dcg+=3/Math.log2(i+2);let ideal=0;for(let i=0;i<Math.min(k,n);i++)ideal+=3/Math.log2(i+2);return {precision:hit/k,recall:n?hit/n:null,ndcg:ideal?dcg/ideal:null};};
 let cold;
 try{
  const start=performance.now();const warm=await s.recall({query:queries[0].query});cold={ms:performance.now()-start,mode:warm.retrieval_mode};
  for(const q of queries){
   const labels=new Set(Object.keys(q.relevant).map(uuid)),ids=[],pages=[],cursors=new Set();let request=modern?{query:q.query,mode:q.mode,view:q.view??'chunks',...(q.limit?{limit:q.limit}:{}),...(q.context?{context:q.context}:{})}:{query:q.query,...(q.limit?{limit:Math.min(q.limit,10)}:{}),...(q.context?{context:q.context}:{})};
   const totalStart=performance.now();let firstStatus;const targetHits=new Set();
   do{
    stats={bodies:0,chunks:0,parses:0,vector_queries:0,vector_rows:0};const start=performance.now(),r=await s.recall(request),ms=performance.now()-start,observed=stats;stats=null;
    if(r.retrieval_mode!=='hybrid')throw Error('Unexpected degraded evaluation: '+JSON.stringify(r.warnings));
    firstStatus??=r.evidence_status;const wire=JSON.stringify(r);pages.push({ms,...observed,count:r.items.length,tokens:Math.ceil(Buffer.byteLength(wire)/3),bytes:Buffer.byteLength(wire)});ids.push(...r.items.map(x=>x.id));for(const [key,target]of Object.entries(q.targets??{}))if(r.items.some(x=>x.id===uuid(key)&&x.content.includes(target)))targetHits.add(key);
    if(!r.has_more)break;if(cursors.has(r.next_cursor))throw Error('Cursor loop');cursors.add(r.next_cursor);request={cursor:r.next_cursor};
   }while(true);
   const unique=[...new Set(ids)],firstRelevant=unique.findIndex(id=>labels.has(id));samples.push({target_count:Object.keys(q.targets??{}).length,target_hits:targetHits.size,rejected_before_adopted:q.adopted?(unique.includes(uuid(q.rejected))&&(!unique.includes(uuid(q.adopted))||unique.indexOf(uuid(q.rejected))<unique.indexOf(uuid(q.adopted)))):null,id:q.id,category:q.category,mode:q.mode,gold:labels.size,first_count:pages[0].count,returned:ids.length,unique:unique.length,relevant:unique.filter(id=>labels.has(id)).length,duplicates:ids.length-unique.length,ids:unique,p1:rankMetrics(unique,labels,1),p3:rankMetrics(unique,labels,3),p5:rankMetrics(unique,labels,5),p20:rankMetrics(unique,labels,20),cumulative_recall:labels.size?unique.filter(id=>labels.has(id)).length/labels.size:null,mrr:labels.size?(firstRelevant<0?0:1/(firstRelevant+1)):null,irrelevant:unique.filter(id=>!labels.has(id)).length,wrong_sufficient:labels.size===0&&firstStatus==='related_evidence',ms:performance.now()-totalStart,pages});
  }
  const avg=(a,key)=>a.reduce((n,x)=>n+x[key],0)/a.length,summary=a=>{const answer=a.filter(x=>x.gold),empty=a.filter(x=>!x.gold),allPages=a.flatMap(x=>x.pages),lat=allPages.map(x=>x.ms).sort((a,b)=>a-b),pct=p=>lat[Math.ceil(lat.length*p)-1];return {queries:a.length,snippet_targets:a.reduce((n,x)=>n+x.target_count,0),snippet_hits:a.reduce((n,x)=>n+x.target_hits,0),rejected_before_adopted:a.filter(x=>x.rejected_before_adopted===true).length,adoption_queries:a.filter(x=>x.rejected_before_adopted!==null).length,p50_ms:pct(.5),p95_ms:pct(.95),first_count:avg(a,'first_count'),returned:avg(a,'returned'),precision1:avg(a.map(x=>x.p1),'precision'),precision3:avg(a.map(x=>x.p3),'precision'),precision5:avg(a.map(x=>x.p5),'precision'),precision20:avg(a.map(x=>x.p20),'precision'),recall5:avg(answer.map(x=>x.p5),'recall'),recall20:avg(answer.map(x=>x.p20),'recall'),ndcg5:avg(answer.map(x=>x.p5),'ndcg'),ndcg20:avg(answer.map(x=>x.p20),'ndcg'),mrr:avg(answer,'mrr'),cumulative_recall:avg(answer,'cumulative_recall'),irrelevant_fraction:a.reduce((n,x)=>n+x.irrelevant,0)/Math.max(1,a.reduce((n,x)=>n+x.unique,0)),duplicates:a.reduce((n,x)=>n+x.duplicates,0),false_sufficient:empty.filter(x=>x.wrong_sufficient).length,no_answer_queries:empty.length,tokens_per_query:a.reduce((n,x)=>n+x.pages.reduce((n,p)=>n+p.tokens,0),0)/a.length,bodies_per_page:avg(allPages,'bodies'),chunks_per_page:avg(allPages,'chunks'),json_parses_per_page:avg(allPages,'parses')};};
  const report={label,fingerprint,cold,rss_bytes:process.memoryUsage().rss,max_rss_kib:process.resourceUsage().maxRSS,summary:summary(samples),by_category:Object.fromEntries([...new Set(samples.map(x=>x.category))].map(c=>[c,summary(samples.filter(x=>x.category===c))])),by_mode:Object.fromEntries(['focused','broad'].map(m=>[m,summary(samples.filter(x=>x.mode===m))])),samples};await writeFile(join(dir,label+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,samples:undefined}));
 }finally{stats=null;JSON.parse=parse;s.close();}
}else throw Error('Expected build or measure');
