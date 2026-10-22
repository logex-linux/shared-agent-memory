// Compare an existing compiled kernel against the new kernel, on the same synthetic snapshots.
// Baseline preparation is explicit and modifies only a disposable copy of dist.
import {readFile,writeFile,mkdir,cp,symlink,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';import {createHash} from 'node:crypto';
const [command,kernelArg='dist',sizeArg='100',outputArg='.local/retrieval-benchmark',corpusArg='.local/scale-benchmark']=process.argv.slice(2),output=resolve(outputArg),kernel=resolve(kernelArg),size=Number(sizeArg),corpus=resolve(corpusArg);
await mkdir(output,{recursive:true});
if(command==='freeze'){
 const target=join(output,'baseline');await cp(kernel,join(target,'dist'),{recursive:true});await symlink(resolve('node_modules'),join(target,'node_modules'));
 const path=join(target,'dist/core/service.js'),code=await readFile(path,'utf8'),needle='rows.sort((a, b) =>';
 if(!code.includes(needle))throw Error('Expected 0.2.0 recall sort marker');
 await writeFile(path,code.replace(needle,'if(globalThis.__recallAudit)Object.assign(globalThis.__recallAudit,{candidate_ids:scores.size,candidates_ranked:rows.length});\n                '+needle));
 console.log(JSON.stringify({frozen:target,note:'Only a candidate counter was added to the disposable baseline.'}));process.exit(0);
}
if(command!=='measure')throw Error('Commands: freeze KERNEL SIZE OUTPUT; measure KERNEL SIZE OUTPUT [CORPUS]');
const label=createHash('sha256').update(kernel).digest('hex').slice(0,8),database=join(output,`${label}-${size}.db`);
await copyFile(join(corpus,size+'.db'),database);
const {MemoryService}=await import(pathToFileURL(join(kernel,'core/service.js')).href);
const config={database,model_dir:resolve('.local/models/bge-small-zh-v1.5'),allowed_projects:['12345678-1234-4234-8234-123456789abc'],allow_global:false,all_projects:false,operations:['recall'],semantic_threshold:0.425,evidence_threshold:0.575,dtype:'fp32',threads:2};
const service=new MemoryService(config),cases=JSON.parse(await readFile('bench/cases.json','utf8')),gold=JSON.parse(await readFile(join(corpus,'gold.json'),'utf8'));
const prepare=service.db.prepare.bind(service.db),parse=JSON.parse;let stats=null;let plan=null;
service.db.prepare=function(sql){
 const stmt=prepare(sql);
 for(const name of ['all','get']){const call=stmt[name].bind(stmt);stmt[name]=(...args)=>{
  const result=call(...args);
  if(stats){const rows=name==='all'?result:result?[result]:[];
   for(const row of rows)if(typeof row.body==='string'){stats.full_body_records++;stats.body_bytes+=Buffer.byteLength(row.body);}
   if(sql.includes('vec_distance_cosine')){stats.vector_queries++;stats.vector_rows_returned+=rows.length;stats.scalar_distance_result_rows+=rows.length;}
   if(sql.includes('embedding MATCH')){stats.vector_queries++;stats.vector_rows_returned+=rows.length;stats.vector_distances_computed=null;if(!plan)plan=prepare('EXPLAIN QUERY PLAN '+sql).all(...args);}
  }return result;
 };}return stmt;
};
JSON.parse=function(value,...args){if(stats){stats.json_parses++;if(typeof value==='string'&&value.includes('"content":')&&value.includes('"verification":'))stats.record_json_parses++;}return parse(value,...args);};
const samples=[];
try{
 await service.recall({query:cases[0][2],limit:5});
 for(let round=0;round<3;round++)for(const [i,c]of cases.entries()){
  stats={full_body_records:0,body_bytes:0,json_parses:0,record_json_parses:0,vector_queries:0,vector_rows_returned:0,vector_distances_computed:null,scalar_distance_result_rows:0};globalThis.__recallAudit=stats;
  const start=performance.now(),result=await service.recall({query:c[2],limit:5}),ms=performance.now()-start,observed=stats;stats=null;
  if(result.retrieval_mode!=='hybrid')throw Error('Benchmark degraded: '+result.warnings);
  const wire=JSON.stringify(result),index=result.items.findIndex(item=>item.id===gold[i]);
  samples.push({...observed,case:i,round,ms,candidate_ids:result.diagnostics?.candidate_ids??observed.candidate_ids,candidates_ranked:result.diagnostics?.candidates_ranked??observed.candidates_ranked,hit:index>=0,reciprocal_rank:index<0?0:1/(index+1),false_returned:result.items.filter(x=>x.id!==gold[i]).length,returned:result.items.length,response_bytes:Buffer.byteLength(wire),content_characters:result.items.reduce((n,x)=>n+x.content.length,0),estimated_tokens:Math.ceil(Buffer.byteLength(wire)/3),diagnostics:result.diagnostics,ids:result.items.map(x=>x.id)});
 }
 const p=q=>samples.map(x=>x.ms).sort((a,b)=>a-b)[Math.ceil(samples.length*q)-1],mean=key=>samples.reduce((n,x)=>n+x[key],0)/samples.length;
 const report={size,samples:samples.length,kernel_label:label,protocol:'20 single-gold synthetic queries, 3 rounds, one warmup, core hybrid recall; includes optional observational counters, excludes cold start and MCP transport',p50_ms:p(.5),p95_ms:p(.95),recall_at_5:mean('hit'),mrr:mean('reciprocal_rank'),false_return_rate:samples.reduce((n,x)=>n+x.false_returned,0)/samples.reduce((n,x)=>n+x.returned,0),mean_full_bodies:mean('full_body_records'),mean_json_parses:mean('json_parses'),mean_record_json_parses:mean('record_json_parses'),mean_vector_rows:mean('vector_rows_returned'),mean_candidates:mean('candidate_ids'),mean_ranked_candidates:mean('candidates_ranked'),mean_response_bytes:mean('response_bytes'),mean_tokens:mean('estimated_tokens'),rss_bytes:process.memoryUsage().rss,max_rss_kib:process.resourceUsage().maxRSS,plan,measurements:samples};
 await writeFile(join(output,`${label}-${size}.json`),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,measurements:undefined}));
}finally{stats=null;JSON.parse=parse;service.close();}
