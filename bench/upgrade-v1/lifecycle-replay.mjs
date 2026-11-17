import assert from 'node:assert/strict';
import {copyFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isolatedWorkspace,reportDirectory,writeRunReport} from '../../scripts/artifacts.mjs';

const root=await isolatedWorkspace('lifecycle-replay');
const [baseline,baselineDist,candidateDist,output]=process.argv.slice(2);
if(!baseline||!baselineDist)throw Error('Usage: lifecycle-replay.mjs BASELINE_BACKUP BASELINE_DIST [CANDIDATE_DIST] [REPORT_DIRECTORY]');
const {performance:queries,lifecycle}=JSON.parse(await readFile(join(baseline,'replay-input.json'),'utf8'));
const snapshot=JSON.parse(await readFile(join(baseline,'baseline.json'),'utf8'));
const original=join(baseline,'memory-schema12.db');
const libraries=[];
try {
  for(const build of [baselineDist,...(candidateDist?[candidateDist]:[])]) {
    const {MemoryService}=await import(pathToFileURL(join(resolve(build),'core/service.js')));
    const database=join(root,'library-'+libraries.length+'.db');
    await copyFile(original,database);
    const {model_dir,allowed_projects,all_projects,allow_global}=snapshot.clients.codex;
    const service=new MemoryService({database,model_dir,allowed_projects,all_projects,allow_global});
    libraries.push({service,build:resolve(build),times:[],schema:service.storage.schema()});
    await service.encoder.profile();
    await service.recall(queries[0]);
  }
  for(let round=0;round<8;round++)for(const query of queries) {
    const pair=round%2?[...libraries].reverse():libraries;
    for(const library of pair) {
      const start=performance.now();
      const result=await library.service.recall(query);
      library.times.push(performance.now()-start);
      assert.equal(result.retrieval_mode,'hybrid');
    }
  }
  const readings=[];
  for(const {service,times,build,schema} of libraries) {
    const sorted=[...times].sort((a,b)=>a-b);
    const hints=[];
    for(const query of queries) {
      const result=await service.recall({...query,debug:true});
      assert.equal(result.diagnostics.full_body_records_read,0);
      hints.push(result.items.map(({id,revision})=>({id,revision})));
    }
    const current=[];
    for(const query of lifecycle) {
      const result=await service.recall(query);
      current.push(result.items.map(({id,revision,applicability,lifecycle})=>({id,revision,applicability,lifecycle})));
    }
    readings.push({schema,build,times,p50:sorted[Math.ceil(sorted.length*.5)-1],p95:sorted[Math.ceil(sorted.length*.95)-1],hints,current});
  }
  const ratio=readings[1]?readings[1].p95/readings[0].p95:null;
  const results={generation:snapshot.meta.generation,queries:queries.length,readings,ratio};
  const directory=await reportDirectory(output,'lifecycle-replay');
  await writeRunReport(root,results,{directory,name:'lifecycle-replay.json'});
  console.log(JSON.stringify({samples:readings[0].times.length,p95:readings.map(r=>r.p95),ratio}));
  if(readings.length===2) {
    assert.deepEqual(readings[1].hints,readings[0].hints);
    assert.ok(ratio<=1.15,'Frozen-corpus recall exceeded the p95 limit');
  }
} finally {for(const {service} of libraries)service.close();}
