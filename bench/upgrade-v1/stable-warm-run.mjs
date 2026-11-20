// Warm ordinary-recall timing for one runtime on a disposable copy of the
// current canonical database. One process, one client, real CPU BGE.
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync,backup} from 'node:sqlite';

const [runtimeArg,outputArg]=process.argv.slice(2);
if(!runtimeArg||!outputArg)throw Error('Usage: stable-warm-run.mjs RUNTIME_DIST OUTPUT_JSON');
const runtime=resolve(runtimeArg),output=resolve(outputArg);
const inputs=JSON.parse(await readFile('/Users/linnx/.agents/backups/shared-agent-memory/evidence-quality-20261118-KWroJc/replay-input.json','utf8')).performance;
const live=JSON.parse(await readFile('/Users/linnx/Library/Application Support/SharedAgentMemory/config.json','utf8'));
const root=await mkdtemp(join(tmpdir(),'sam-warm-'));
const database=join(root,'memory.db');
const source=new DatabaseSync(live.database,{readOnly:true});
try {await backup(source,database);} finally {source.close();}
const {MemoryService}=await import(pathToFileURL(join(runtime,'core/service.js')));
const service=new MemoryService({...live,database,operations:['recall'],connection_id:'warm-benchmark',diagnostics:false});
const times=[],bodies=[];
try {
    for(const request of inputs)await service.recall(request);
    for(let round=0;round<10;round++)for(const request of inputs){
        const start=performance.now();
        const result=await service.recall(request);
        times.push(performance.now()-start);
        bodies.push(result.diagnostics?.full_body_records_read??0);
    }
} finally {service.close();await rm(root,{recursive:true,force:true});}
const sorted=[...times].sort((a,b)=>a-b),q=p=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))];
const report={format:'shared-agent-memory/stable-warm-run-v1',runtime,generated_at:new Date().toISOString(),
    queries:inputs.length,count:times.length,p50:q(.5),p95:q(.95),max:Math.max(...times),full_body_reads:bodies.reduce((a,b)=>a+b,0),times};
await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({runtime,count:report.count,p50:report.p50,p95:report.p95,max:report.max,full_body_reads:report.full_body_reads},null,2));
