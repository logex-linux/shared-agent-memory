// Synthetic size benchmark; build once, measure each snapshot in a fresh process.
import {readFile,writeFile,mkdir,access,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
const [mode='build',directory='.local/scale-benchmark',kernel='dist',sizeArg]=process.argv.slice(2);
const output=resolve(directory),dist=resolve(kernel),cases=JSON.parse(await readFile('bench/cases.json','utf8'));
const {MemoryService}=await import(pathToFileURL(join(dist,'core/service.js')).href);
const model=resolve('.local/models/bge-small-zh-v1.5'),project='12345678-1234-4234-8234-123456789abc';
const config=db=>({database:db,model_dir:model,allowed_projects:[project],all_projects:false,allow_global:false,operations:['recall','propose','commit','forget','manage'],semantic_threshold:0.425,evidence_threshold:0.575,dtype:'fp32',threads:2});
const percentile=(v,p)=>[...v].sort((a,b)=>a-b)[Math.ceil(v.length*p)-1];
const themes=['花卉浇水','仓库盘点','图书借阅','城市天气','徒步路线','餐厅菜单','停车登记','物流分拣','照片归档','体育器材','农场播种','交通统计','园区设施','社区活动','展览日程','教室座位','车辆保养','花园修剪','客房清洁','食堂库存'];
if(mode==='measure'){
 const size=Number(sizeArg),measurement=join(output,'measure-'+createHash('sha256').update(dist).digest('hex').slice(0,8)+'-'+size+'.db');
 await copyFile(join(output,size+'.db'),measurement);
 const s=new MemoryService(config(measurement));
 if(Number(s.db.prepare('SELECT count(*) n FROM memories').get().n)!==size)throw Error('Snapshot size mismatch');
 try{
  const gold=JSON.parse(await readFile(join(output,'gold.json'),'utf8'));const latencies=[],checks=[];
  await s.recall({query:cases[0][2],limit:5});
  for(let round=0;round<3;round++)for(const [i,c]of cases.entries()){
   const start=performance.now(),r=await s.recall({query:c[2],limit:5});latencies.push(performance.now()-start);
   if(r.retrieval_mode!=='hybrid')throw Error('Benchmark degraded');
   checks.push({case:i,round,hit:r.items.some(item=>item.id===gold[i])});
  }
  console.log(JSON.stringify({size,samples:latencies.length,p50_ms:percentile(latencies,.5),p95_ms:percentile(latencies,.95),recall_at_5:checks.filter(c=>c.hit).length/checks.length,rss_bytes:process.memoryUsage().rss,max_rss_kib:process.resourceUsage().maxRSS,checks}));
 }finally{s.close();}
}else{
 await mkdir(output,{recursive:true});const s=new MemoryService(config(join(output,'build.db'))),gold=[];let count=0;
 await s.project(project,'synthetic-benchmark',output);
 count=Number(s.db.prepare('SELECT count(*) n FROM memories').get().n);
 if(count){gold.push(...JSON.parse(await readFile(join(output,'gold.json'),'utf8')));console.log(JSON.stringify({resuming_from:count}));}
 try{
  for(const size of [100,1000,10000]){
   if(count>=size){try{await access(join(output,size+'.db'));continue;}catch(error){if(error.code!=='ENOENT')throw error;if(count>size)throw Error('Missing earlier snapshot');}}
   for(;count<size;count++){
    const c=cases[count],theme=themes[count%themes.length];
    const title=c?c[0]:`${theme}资料 ${count}`,content=c?c[1]:`${theme}的独立登记记录：第${count}批次，分区${count%37}，数量${count%113}。当天按清单核对并保留登记日期，供后续统计查询。`;
    const p=await s.propose({request_id:randomUUID(),record:{project_id:project,scope:'project',kind:'procedure',title,content,sources:[{source_type:'test',uri:'test://scale/'+count,locator:'synthetic corpus',revision_ref:'v1',checked_at:'2026-01-01T00:00:00.000Z'}],verification:{method:'synthetic benchmark',summary:'Not user history'},author_client:'benchmark',author_session:'scale'}});
    const m=await s.commit({request_id:randomUUID(),proposal_id:p.proposal_id,expected_revision:0});if(c)gold.push(m.memory_id);
    if(count%500===0)console.log(JSON.stringify({built:count,target:10000}));
   }
   await writeFile(join(output,'gold.json'),JSON.stringify(gold));const db=new DatabaseSync(s.config.database,{readOnly:true});try{await backup(db,join(output,size+'.db'));}finally{db.close();}
   console.log(JSON.stringify({snapshot:size}));
  }
 }finally{s.close();}
 console.log(JSON.stringify({build_complete:true,output}));
}
