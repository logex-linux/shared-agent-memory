import {mkdtemp,copyFile,readFile,writeFile,realpath} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {BgeEncoder} from '../../dist/embedding/bge.js';
const [output,corpus,baseline,modern='dist']=process.argv.slice(2);
if(!output||!corpus||!baseline)throw Error('Usage: phase-probe.mjs OUTPUT CORPUS_DB BASELINE_DIST [CURRENT_DIST]');
const root=await mkdtemp(join(await realpath(output),'phase-probe-'));
const options={model_dir:resolve('.local/models/bge-small-zh-v1.5'),dtype:'fp32',threads:2,operations:['recall'],
  allowed_projects:['12345678-1234-4234-8234-123456789abc']};
const encoder=new BgeEncoder(options),cases=JSON.parse(await readFile('bench/cases.json'));
const services={};
for(const [arm,kernel] of [['A',baseline],['B',modern]]){
 const database=join(root,arm+'.db');
 assert.equal(dirname(database),root);
 await copyFile(corpus,database);
 const {MemoryService}=await import(pathToFileURL(resolve(kernel,'core/service.js')));
 services[arm]=new MemoryService({...options,database},encoder);
}
const stats={A:[],B:[]};
try{
 const input=c=>({query:c[2],debug:true,mode:'focused',view:'evidence',limit:5});
 for(const service of Object.values(services))await service.recall(input(cases[0]));
 for(let round=0;round<3;round++)for(const c of cases.slice(0,12)){
  for(const arm of round%2?['B','A']:['A','B']){
   const r=await services[arm].recall(input(c));
   assert.equal(r.retrieval_mode,'hybrid');
   assert.equal(r.diagnostics.full_body_records_read,0);
   stats[arm].push(r.diagnostics.stages_ms);
  }
 }
 const quantile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
 const summary=Object.fromEntries(Object.entries(stats).map(([arm,rows])=>[arm,Object.fromEntries(
   [...new Set(rows.flatMap(row=>Object.keys(row)))].map(stage=>[stage, [.5,.95].map(p=>quantile(rows.map(row=>row[stage]??0),p))])
 )]));
 await writeFile(join(root,'report.json'),JSON.stringify({summary,stats},null,2),{mode:0o600});
 console.log(JSON.stringify({root,summary},null,2));
}finally{Object.values(services).forEach(service=>service.close());}
