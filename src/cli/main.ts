import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile,realpath,access,stat } from 'node:fs/promises';
import { resolve, join,basename } from 'node:path';
import { MemoryService, readConfig } from '../core/service.js';
import { hash, MemoryError, recordSchema,configSchema } from '../core/contracts.js';
import { VERSION_ARCHIVE } from '../memory/archive.js';

const args=process.argv.slice(2),command=args.shift();
function flag(name:string,fallback?:string) {const index=args.indexOf('--'+name);return index<0?fallback:args[index+1];}
async function input(){const file=flag('input');if(!file)throw new Error('--input FILE required');return JSON.parse(await readFile(resolve(file),'utf8'));}
async function latestRevocations() {
  const file=flag('revocations');
  if(!file)throw new MemoryError('LATEST_REVOCATIONS_REQUIRED');
  return (await readFile(resolve(file),'utf8')).split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));
}
async function main() {
  if(command==='init') {
    const requested=flag('project');if(!requested)throw new MemoryError('WORK_PROJECT_REQUIRED');
    const root=resolve(flag('root','.local')!),model=resolve(flag('model','.local/models/bge-small-zh-v1.5')!),project=await realpath(resolve(requested));
    if(!(await stat(project)).isDirectory())throw new MemoryError('WORK_PROJECT_NOT_DIRECTORY');
    const id=flag('project-id',randomUUID())!;
    const base={database:join(root,'memory.db'),model_dir:model,allowed_projects:[id],all_projects:true,allow_global:true,semantic_threshold:0.425,evidence_threshold:0.575,dtype:'fp32',threads:2};
    const admin={...base,connection_id:'admin:'+id,operations:['recall','propose','commit','forget','manage','verify']};
    const profiles=[['config.json',{...base,connection_id:'reader:'+id,operations:['recall']}],['project.config.json',{...base,all_projects:false,allow_global:false,connection_id:'writer:'+id,operations:['recall','propose','commit','forget']}],['admin.config.json',admin]] as const;
    for(const [,value]of profiles)configSchema.parse(value);
    for(const [file]of profiles){try{await access(join(root,file));throw new MemoryError('CONFIG_EXISTS');}catch(e:any){if(e.code!=='ENOENT')throw e;}}
    await mkdir(root,{recursive:true,mode:0o700});
    for(const [file,value]of profiles)await writeFile(join(root,file),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
    const service=new MemoryService(await readConfig(join(root,'admin.config.json')));
    try{return {config:join(root,'config.json'),admin_config:join(root,'admin.config.json'),project_config:join(root,'project.config.json'),...await service.project(id,flag('name',basename(project))!,project)};}finally{service.close();}
  }
  const configPath=flag('config',process.env.SHARED_MEMORY_CONFIG);
  if(!configPath)throw new Error('--config FILE or SHARED_MEMORY_CONFIG required');
  const service=new MemoryService(await readConfig(resolve(configPath)));
  try {
    switch(command) {
      case 'cache-inspect':return service.cache();
      case 'cache-maintenance':return service.cache(true);
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
      case 'export':return await service.export(flag('project')!,args.includes('--global'),flag('format','json') as 'json'|'markdown'|'versioned');
      case 'import': {
        const data=await input();
        const mode=flag('mode');
        if(mode && !['new','restore'].includes(mode))throw new MemoryError('IMPORT_MODE_INVALID');
        const commit=args.includes('--commit');
        if(commit && !mode)throw new MemoryError('IMPORT_MODE_REQUIRED');
        if(data?.format===VERSION_ARCHIVE) {
          if(mode==='new')throw new MemoryError('RESTORE_METADATA_NOT_ALLOWED');
          const entries=service.previewArchive(data);
          if(!commit)return {dry_run:true,entries};
          await service.applyRevocations(await latestRevocations());
          return {dry_run:false,...await service.restoreArchive(data)};
        }
        const memories=Array.isArray(data)?data:data?.memories;
        if(!Array.isArray(memories))throw new Error('Expected records array or export object');
        const restored=(entry:any)=>['id','revision','content_hash'].some(key=>Object.hasOwn(entry,key));
        if(mode==='new' && (!Array.isArray(data) || memories.some(restored)))throw new MemoryError('RESTORE_METADATA_NOT_ALLOWED');
        // Every committed import checks the external ledger, even arrays of raw bodies.
        // Syntax cannot prove that an apparent new body was never exported before.
        memories.forEach((entry:any)=>service.previewImport(entry));
        if(commit)await service.applyRevocations(await latestRevocations());
        const entries=[];
        for(const entry of memories) {
          const preview=service.previewImport(entry);
          const result:any={import_key:preview.import_key,source_hash:preview.source_hash,action:preview.action,source_uris:preview.record.sources.map(s=>s.uri)};
          if(commit && !preview.action.startsWith('blocked'))result.result=await service.importEntry(entry);
          entries.push(result);
        }
        return {dry_run:!commit,entries};
      }
      default:throw new Error('Commands: cache-inspect cache-maintenance init project resolve-project inspect recall propose commit forget discard-proposal import export reindex check maintenance');
    }
  } finally {service.close();}
}
try {console.log(JSON.stringify(await main(),null,2));}
catch(error) {console.error(JSON.stringify({error:error instanceof MemoryError?error.code:error instanceof Error?error.message:'UNKNOWN',...(error instanceof MemoryError?error.details:undefined)}));process.exitCode=1;}
