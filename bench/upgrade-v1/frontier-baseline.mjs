import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFile,readFile,stat,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isolatedWorkspace} from '../../scripts/artifacts.mjs';
import {frontierFingerprint,frontierFixtures} from './frontier-fixtures.mjs';
import {fingerprint as lifecycleFingerprint} from './tasks.mjs';

const [root,inputFile,clientFile,candidateDist]=process.argv.slice(2);
if(!root||!inputFile||!clientFile)throw Error('Usage: frontier-baseline.mjs BACKUP REPLAY_INPUT CLIENT_CONFIG [CANDIDATE_DIST]');
const storage=join(root,'backup','memory.db'), saved=join(root,'frontier-baseline.json');
const frozen=candidateDist?JSON.parse(await readFile(saved,'utf8')):null;
const {commit,version,schema}=JSON.parse(await readFile(join(root,'installed.json'),'utf8'));
const {performance:queries}=JSON.parse(await readFile(inputFile,'utf8'));
const {model_dir,allowed_projects,all_projects,allow_global,dtype,threads}=JSON.parse(await readFile(clientFile,'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const digest=async file=>hash(await readFile(file));
const workspace=await isolatedWorkspace('frontier-replay');
const builds=[join(root,'runtime','dist'),...(candidateDist?[resolve(candidateDist)]:[])];
const quantile=(samples,q)=>[...samples].sort((a,b)=>a-b)[Math.ceil(samples.length*q)-1];
const libraries=[];
try {
  for(const [index,dist] of builds.entries()){
    const {MemoryService}=await import(pathToFileURL(join(dist,'core/service.js')));
    const database=join(workspace,`memory-${index}.db`);
    await copyFile(storage,database);
    const service=new MemoryService({database,model_dir,allowed_projects,all_projects,allow_global,dtype,threads});
    libraries.push({service,database,times:[]});
  }
  const labels=Object.fromEntries(await Promise.all([
    ['canonical',storage],['revocations',join(root,'backup','revocations.jsonl')],
    ['maintenance',join(root,'backup','maintenance.json')],['input',inputFile]
  ].map(async ([key,file])=>[key,await digest(file)])));
  const signing=service=>hash(JSON.stringify(service.db.prepare('SELECT memory_id,revision,content_hash FROM memory_versions ORDER BY memory_id,revision').all()));
  const signature=signing(libraries[0].service);
  assert.ok(libraries.every(({service})=>signing(service)===signature));
  const started=performance.now();
  const model=(await libraries[0].service.encoder.profile()).id;
  const initialization_ms=performance.now()-started;
  const corpus={commit,version,schema,labels,signature,model,generation:libraries[0].service.storage.generation()};
  if(frozen)assert.deepEqual(corpus,frozen.corpus);
  for(const {service} of libraries)for(const query of queries)await service.recall(query);
  for(let round=0;round<10;round++)for(const query of queries){
    for(const library of (round%2?[...libraries].reverse():libraries)){
      const start=performance.now();
      const response=await library.service.recall(query);
      library.times.push(performance.now()-start);
      assert.equal(response.retrieval_mode,'hybrid');
    }
  }
  const results=[];
  for(const {service,database,times} of libraries){
    const hints=[];
    for(const query of queries){
      const response=await service.recall({...query,debug:true});
      assert.equal(response.diagnostics.full_body_records_read,0);
      hints.push(response.items.map(({id,revision})=>[id,revision]));
    }
    results.push({p50:quantile(times,.5),p95:quantile(times,.95),trials:times.length,
      schema:service.storage.schema(),db_bytes:(await stat(database)).size,result_signature:hash(JSON.stringify(hints))});
  }
  const contract={ordinary_p95_ratio:1.10,pack_hot_ms:results[0].p95*3,quality_lower_bound:-.02,
    token_reduction:.20,success_gain:.05,frontierFingerprint,lifecycleFingerprint,
    splits:Object.fromEntries(['development','calibration','holdout'].map(split=>[split,frontierFixtures.filter(x=>x.split===split).length]))};
  if(frozen)assert.deepEqual(results.map(r=>r.result_signature),builds.map(()=>frozen.results[0].result_signature));
  const report={corpus,contract:frozen?.contract??contract,initialization_ms,results,rss_high_water_bytes:process.resourceUsage().maxRSS*1024,
    frozen_ratio:frozen?results[1].p95/frozen.results[0].p95:null,paired_ratio:frozen?results[1].p95/results[0].p95:null};
  const target=frozen?join(root,'frontier-ordinary-replay.json'):saved;
  await writeFile(target,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({report:target,p95:results.map(r=>r.p95),trials:results[0].trials,ratio:report.paired_ratio}));
  if(frozen)assert.ok(Math.max(report.frozen_ratio,report.paired_ratio)<=report.contract.ordinary_p95_ratio,'ordinary hot p95 regression');
}finally{
  for(const {service} of libraries)service.close();
}
