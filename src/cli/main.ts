import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile,realpath,access,stat,rm,chmod } from 'node:fs/promises';
import { DatabaseSync,backup } from 'node:sqlite';
import { resolve, join,basename } from 'node:path';
import { MemoryService, readConfig } from '../core/service.js';
import { hash, MemoryError, recordSchema,configSchema } from '../core/contracts.js';
import { VERSION_ARCHIVE, LEGACY_VERSION_ARCHIVE } from '../memory/archive.js';
import { maintenancePath, prefixOf, readMaintenance, readRevocations, revocationSubset, revocationsPath } from '../memory/recovery.js';
import { artifactHash, readInstallation } from '../storage/installation.js';

const args=process.argv.slice(2),command=args.shift();
function flag(name:string,fallback?:string) {const index=args.indexOf('--'+name);return index<0?fallback:args[index+1];}
async function input(){const file=flag('input');if(!file)throw new Error('--input FILE required');return JSON.parse(await readFile(resolve(file),'utf8'));}
async function latestRevocations() {
  const file=flag('revocations');
  if(!file)throw new MemoryError('LATEST_REVOCATIONS_REQUIRED');
  return (await readFile(resolve(file),'utf8')).split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));
}
function latestMaintenance() {
  const file=flag('maintenance');
  if(!file)throw new MemoryError('LATEST_MAINTENANCE_REQUIRED');
  return readMaintenance(resolve(file));
}
async function recoverBackup(configPath:string) {
  const source=flag('source'),output=flag('output');
  if(!source||!output)throw new MemoryError('RECOVERY_SOURCE_AND_OUTPUT_REQUIRED');
  const revocations=await latestRevocations(),maintenance=latestMaintenance(),config=await readConfig(configPath);
  if(!config.operations.includes('manage')||!config.all_projects||!config.allow_global)throw new MemoryError('MAINTENANCE_SCOPE_DENIED');
  if(config.maintenance_state&&(!prefixOf(readMaintenance(maintenancePath(config)),maintenance)||
    !revocationSubset(readRevocations(revocationsPath(config)),revocations)))throw new MemoryError('LATEST_RECOVERY_STATE_REQUIRED');
  try {
    await access(config.database);
    const active=new DatabaseSync(config.database,{readOnly:true});
    try {
      if(active.prepare("SELECT 1 FROM meta WHERE key IN ('revocations_pending','maintenance_pending','recovery_pending') AND value<>0 LIMIT 1").get())
        throw new MemoryError('RECOVERY_CLEANUP_PENDING');
    } finally {active.close();}
  } catch(error:any){if(error.code!=='ENOENT')throw error;}
  const inputPath=await realpath(resolve(source)),out=resolve(output);
  if(!(await stat(inputPath)).isFile())throw new MemoryError('RECOVERY_SOURCE_INVALID');
  await mkdir(out,{mode:0o700});
  const database=join(out,'memory.db');
  let service:MemoryService|undefined;
  try {
    const db=new DatabaseSync(inputPath,{readOnly:true});
    try {await backup(db,database);}
    finally {db.close();}
    await chmod(database,0o600);
    service=new MemoryService({...config,database,maintenance_state:out},undefined,undefined,true);
    const result=await service.recover(maintenance,revocations);
    await writeFile(join(out,'restore-report.json'),JSON.stringify({...result,source:inputPath,database},null,2)+'\n',{mode:0o600,flag:'wx'});
    return {...result,database,maintenance_state:out};
  } catch(error) {
    service?.close();
    service=undefined;
    await rm(out,{recursive:true,force:true});
    throw error;
  } finally {service?.close();}
}
async function main() {
  if(command==='init') {
    const requested=flag('project');if(!requested)throw new MemoryError('WORK_PROJECT_REQUIRED');
    const root=resolve(flag('root','.local')!),model=resolve(flag('model','.local/models/bge-small-zh-v1.5')!),project=await realpath(resolve(requested));
    if(!(await stat(project)).isDirectory())throw new MemoryError('WORK_PROJECT_NOT_DIRECTORY');
    const id=flag('project-id',randomUUID())!;
    const state=flag('maintenance-state'),manifest=flag('manifest');
    const base={database:join(root,'memory.db'),model_dir:model,
      ...(state&&{maintenance_state:resolve(state)}),...(manifest&&{installation_manifest:resolve(manifest)}),
      allowed_projects:[id],all_projects:true,allow_global:true,semantic_threshold:0.425,evidence_threshold:0.575,dtype:'fp32',threads:2};
    const admin={...base,connection_id:'admin:'+id,operations:['recall','propose','commit','forget','manage','verify']};
    const writer={...base,all_projects:false,allow_global:false,require_work_directory:true,connection_id:'writer:'+id,operations:['recall','propose','commit']};
    const profiles=[['config.json',{...base,connection_id:'reader:'+id,operations:['recall']}],['project.config.json',writer],
      ['project-forget.config.json',{...writer,connection_id:'writer-forget:'+id,operations:[...writer.operations,'forget']}],['admin.config.json',admin]] as const;
    for(const [,value]of profiles)configSchema.parse(value);
    for(const [file]of profiles){try{await access(join(root,file));throw new MemoryError('CONFIG_EXISTS');}catch(e:any){if(e.code!=='ENOENT')throw e;}}
    await mkdir(root,{recursive:true,mode:0o700});
    for(const [file,value]of profiles)await writeFile(join(root,file),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
    const service=new MemoryService(await readConfig(join(root,'admin.config.json')));
    try {
      const registered=await service.project(id,flag('name',basename(project))!,project);
      if(state)await service.maintenance();
      return {config:join(root,'config.json'),admin_config:join(root,'admin.config.json'),project_config:join(root,'project.config.json'),
        project_forget_config:join(root,'project-forget.config.json'),...registered};
    }finally{service.close();}
  }
  const configPath=flag('config',process.env.SHARED_MEMORY_CONFIG);
  if(!configPath)throw new Error('--config FILE or SHARED_MEMORY_CONFIG required');
  if(command==='restore-backup')return recoverBackup(resolve(configPath));
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
      case 'project-aliases':return await service.projectAliases(await input(),args.includes('--apply'));
      case 'diagnose-projects':return service.diagnoseProjects();
      case 'diagnose': {
        const path=flag('manifest',service.config.installation_manifest);
        if(!path)throw new MemoryError('INSTALLATION_MANIFEST_REQUIRED');
        const installed=await readInstallation(path);
        const profile=(await service.encoder.profile()).id;
        return {installation:installed,schema:service.storage.schema(),profile,
          checks:{database:installed.database===service.config.database,model:installed.model_dir===service.config.model_dir,
            profile:installed.model_profile===profile,schema:installed.schema===service.storage.schema(),node:installed.node===await realpath(process.execPath),
            artifacts:installed.artifacts_sha256===await artifactHash(installed.runtime),
            maintenance_state:installed.maintenance_state===(service.config.maintenance_state??resolve(service.config.database,'..'))},
          projects:service.diagnoseProjects()};
      }
      case 'resolve-project':return await service.resolveProject(resolve(flag('path',process.cwd())!));
      case 'reassign':return await service.reassign(await input(),args.includes('--apply'));
      case 'recall':return await service.recall(await input());
      case 'feedback':return await service.feedback(await input());
      case 'project-feedback':return service.projectFeedback(Number(flag('limit','100')),args.includes('--rebuild'));
      case 'consolidate': {
        if(!args.includes('--dry-run')||args.includes('--commit'))throw new MemoryError('CONSOLIDATION_DRY_RUN_REQUIRED');
        return service.consolidate(await input());
      }
      case 'propose':return await service.propose(await input());
      case 'commit':return await service.commit(await input());
      case 'forget': {
        const data=await input();
        return args.includes('--dry-run')?service.forgetPreview({memory_id:data.memory_id,expected_revision:data.expected_revision}):await service.forget(data);
      }
      case 'discard-proposal':return await service.discardProposal(flag('id')!);
      case 'renew-proposal':return service.renewProposal(await input());
      case 'retention':return flag('input')?await service.retention(await input(),args.includes('--apply')):service.retentionCandidates();
      case 'export':return await service.export(flag('project')!,args.includes('--global'),flag('format','json') as 'json'|'markdown'|'versioned');
      case 'import': {
        const data=await input();
        const mode=flag('mode');
        if(mode && !['new','restore'].includes(mode))throw new MemoryError('IMPORT_MODE_INVALID');
        const commit=args.includes('--commit');
        if(commit && !mode)throw new MemoryError('IMPORT_MODE_REQUIRED');
        if(data?.format===VERSION_ARCHIVE||data?.format===LEGACY_VERSION_ARCHIVE) {
          if(mode==='new')throw new MemoryError('RESTORE_METADATA_NOT_ALLOWED');
          const entries=service.previewArchive(data);
          if(!commit)return {dry_run:true,entries};
          const revocations=await latestRevocations();
          service.selectImportMaintenance(latestMaintenance());
          await service.applyRevocations(revocations);
          return {dry_run:false,...await service.restoreArchive(data)};
        }
        const memories=Array.isArray(data)?data:data?.memories;
        if(!Array.isArray(memories))throw new Error('Expected records array or export object');
        const restored=(entry:any)=>['id','revision','content_hash'].some(key=>Object.hasOwn(entry,key));
        if(mode==='new' && (!Array.isArray(data) || memories.some(restored)))throw new MemoryError('RESTORE_METADATA_NOT_ALLOWED');
        // Every committed import checks the external ledger, even arrays of raw bodies.
        // Syntax cannot prove that an apparent new body was never exported before.
        memories.forEach((entry:any)=>service.previewImport(entry));
        if(commit) {
          const revocations=await latestRevocations();
          service.selectImportMaintenance(latestMaintenance());
          await service.applyRevocations(revocations);
        }
        const entries=[];
        for(const entry of memories) {
          const preview=service.previewImport(entry);
          const result:any={import_key:preview.import_key,source_hash:preview.source_hash,action:preview.action,source_uris:preview.record.sources.map(s=>s.uri)};
          if(commit && !preview.action.startsWith('blocked'))result.result=await service.importEntry(entry);
          entries.push(result);
        }
        return {dry_run:!commit,entries};
      }
      default:throw new Error('Commands: init diagnose diagnose-projects project project-aliases resolve-project reassign inspect recall feedback project-feedback consolidate propose commit forget renew-proposal discard-proposal retention import export restore-backup reindex check maintenance cache-inspect cache-maintenance');
    }
  } finally {service.close();}
}
try {console.log(JSON.stringify(await main(),null,2));}
catch(error) {console.error(JSON.stringify({error:error instanceof MemoryError?error.code:error instanceof Error?error.message:'UNKNOWN',...(error instanceof MemoryError?error.details:undefined)}));process.exitCode=1;}
