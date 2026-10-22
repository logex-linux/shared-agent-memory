import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { MemoryService, readConfig } from '../core/service.js';
import { hash, MemoryError, recordSchema } from '../core/contracts.js';

const args=process.argv.slice(2),command=args.shift();
function flag(name:string,fallback?:string) {const index=args.indexOf('--'+name);return index<0?fallback:args[index+1];}
async function input(){const file=flag('input');if(!file)throw new Error('--input FILE required');return JSON.parse(await readFile(resolve(file),'utf8'));}
async function main() {
  if(command==='init') {
    const root=resolve(flag('root','.local')!),model=resolve(flag('model','.local/models/bge-small-zh-v1.5')!),project=resolve(flag('project',process.cwd())!);
    const id=flag('project-id',randomUUID())!;
    await mkdir(root,{recursive:true,mode:0o700});
    const config={database:join(root,'memory.db'),model_dir:model,allowed_projects:[id],all_projects:true,allow_global:true,operations:['recall','propose','commit','forget','manage'],semantic_threshold:0.425,evidence_threshold:0.575,dtype:'fp32',threads:2};
    const path=join(root,'config.json');await writeFile(path,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
    const service=new MemoryService(await readConfig(path));
    try{return {config:path,...await service.project(id,flag('name','shared-agent-memory')!,project)};}finally{service.close();}
  }
  const configPath=flag('config',process.env.SHARED_MEMORY_CONFIG);
  if(!configPath)throw new Error('--config FILE or SHARED_MEMORY_CONFIG required');
  const service=new MemoryService(await readConfig(resolve(configPath)));
  try {
    switch(command) {
      case 'inspect':return await service.inspect();
      case 'check':return await service.check();
      case 'maintenance':return await service.maintenance();
      case 'reindex':return await service.reindex();
      case 'project':return await service.project(flag('id')!,flag('name')!,resolve(flag('alias')!));
      case 'resolve-project':return await service.resolveProject(resolve(flag('path',process.cwd())!));
      case 'recall':return await service.recall(await input());
      case 'propose':return await service.propose(await input());
      case 'commit':return await service.commit(await input());
      case 'forget':return await service.forget(await input());
      case 'discard-proposal':return await service.discardProposal(flag('id')!);
      case 'export':return await service.export(flag('project')!,args.includes('--global'),flag('format','json') as 'json'|'markdown');
      case 'import': {
        const data=await input();
        const memories=Array.isArray(data)?data:data.memories;
        if(!Array.isArray(memories))throw new Error('Expected records array or export object');
        if(args.includes('--commit') && !Array.isArray(data)) {
          const revocationFile=flag('revocations');
          if(!revocationFile)throw new MemoryError('LATEST_REVOCATIONS_REQUIRED');
          const revocations=(await readFile(resolve(revocationFile),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
          await service.applyRevocations(revocations);
          await service.maintenance();
        }
        const entries=[];
        for(const entry of memories) {
          const preview=service.previewImport(entry);
          const result:any={import_key:preview.import_key,source_hash:preview.source_hash,action:preview.action,source_uris:preview.record.sources.map(s=>s.uri)};
          if(args.includes('--commit') && !preview.action.startsWith('blocked'))result.result=await service.importEntry(entry);
          entries.push(result);
        }
        return {dry_run:!args.includes('--commit'),entries};
      }
      default:throw new Error('Commands: init project resolve-project inspect recall propose commit forget discard-proposal import export reindex check maintenance');
    }
  } finally {service.close();}
}
try {console.log(JSON.stringify(await main(),null,2));}
catch(error) {console.error(JSON.stringify({error:error instanceof MemoryError?error.code:error instanceof Error?error.message:'UNKNOWN'}));process.exitCode=1;}
