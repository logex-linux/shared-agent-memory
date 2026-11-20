// Run the frozen six-family stable-release counterexamples against one built
// runtime with the real local BGE model. The canonical database is never used.
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

const [runtimeArg,outputArg]=process.argv.slice(2);
if(!runtimeArg||!outputArg)throw Error('Usage: stable-regressions-run.mjs RUNTIME_DIST OUTPUT_JSON');
const runtime=resolve(runtimeArg),output=resolve(outputArg);
const fixture=JSON.parse(await readFile(new URL('./stable-regressions.json',import.meta.url),'utf8'));
const live=JSON.parse(await readFile('/Users/linnx/Library/Application Support/SharedAgentMemory/config.json','utf8'));
const {MemoryService}=await import(pathToFileURL(join(runtime,'core/service.js')));
const root=await mkdtemp(join(tmpdir(),'sam-stable-run-'));
const projects=fixture.cases.map(()=>randomUUID());
const config={database:join(root,'memory.db'),model_dir:live.model_dir,allowed_projects:projects,all_projects:true,
    allow_global:true,operations:['recall','propose','commit','manage'],semantic_threshold:live.semantic_threshold,
    evidence_threshold:live.evidence_threshold,dtype:live.dtype,threads:live.threads,connection_id:'stable-regression'};
const record=(project,spec)=>({project_id:project,scope:'project',kind:'fact',title:spec.title,content:spec.content,
    tags:['stable-regression'],sources:[{source_type:'test',uri:'test://stable/'+encodeURIComponent(spec.title),
    locator:'frozen synthetic case',revision_ref:'2026-11-20',checked_at:'2026-11-20T00:00:00.000Z'}],
    verification:{method:'frozen synthetic regression',summary:'Synthetic counterexample, not user history.',status:'unverified',basis:'source_claim'},
    valid_for:{},author_client:'stable-regression',author_session:'beta7',derived_from:[]});
const publish=async(service,value)=>{const proposal=await service.propose({request_id:randomUUID(),record:value});
    return service.commit({request_id:randomUUID(),proposal_id:proposal.proposal_id,expected_revision:0});};
const service=new MemoryService(config);
const rows=[];
try {
    for(const [index,scenario] of fixture.cases.entries()) {
        const project=projects[index];
        await mkdir(join(root,String(index)));
        await service.project(project,scenario.family,join(root,String(index)));
        const wrong=await publish(service,record(project,scenario.distractor));
        const read={query:scenario.query,mode:'focused',view:'evidence',limit:5,max_bytes:8000,project_id:project,debug:true};
        const before=await service.recall(read);
        const gold=await publish(service,record(project,scenario.direct));
        const after=await service.recall(read);
        const view=page=>({status:page.evidence_status,warnings:page.warnings,items:page.items.map(item=>({
            role:item.id===wrong.memory_id?'wrong_entity':item.id===gold.memory_id?'gold':'other',
            id:item.id,revision:item.revision,strength:item.evidence_strength,level:item.support?.level??null,
            basis:item.support?.basis??null,qualifiers_covered:item.support?.qualifiers_covered??null,
            qualifiers_required:item.support?.qualifiers_required??null,answer_covered:item.support?.answer_covered??null,
            title:item.title}))});
        rows.push({key:scenario.key,family:scenario.family,query:scenario.query,before:view(before),after:view(after)});
    }
} finally {service.close();await rm(root,{recursive:true,force:true});}
const metrics={
    families:rows.length,
    before_wrong_supported:rows.filter(row=>row.before.items.some(item=>item.role==='wrong_entity'&&item.strength==='supported')).length,
    after_gold_top5:rows.filter(row=>row.after.items.slice(0,5).some(item=>item.role==='gold'&&item.strength==='supported')).length,
    after_wrong_supported:rows.filter(row=>row.after.items.some(item=>item.role==='wrong_entity'&&item.strength==='supported')).length
};
const report={format:'shared-agent-memory/stable-regressions-run-v1',runtime,generated_at:new Date().toISOString(),
    fixture:new URL('./stable-regressions.json',import.meta.url).pathname,metrics,rows};
await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({runtime,output,metrics},null,2));
