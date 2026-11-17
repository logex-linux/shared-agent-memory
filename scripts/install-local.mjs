// Explicit one-time setup. Existing config/data is never overwritten.
import {mkdir,cp,access,realpath,stat,readFile,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf('--'+name);return i<0?fallback:args[i+1];};
if(!/^v24\./.test(process.version))throw Error('Use Node 24.18.0');
const code=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(option('root',join(homedir(),'.local/share/shared-agent-memory'))),requested=option('project'),project=requested?await realpath(resolve(requested)):null,source=resolve(option('model',join(code,'.local/models/bge-small-zh-v1.5')));
if(!project)throw Error('WORK_PROJECT_REQUIRED: pass --project /absolute/path/to/your-work-project');
if(!(await stat(project)).isDirectory())throw Error('WORK_PROJECT_NOT_DIRECTORY');
try{await access(join(root,'config.json'));throw Error('Configuration exists; use maintenance instructions instead');}catch(error){if(error.code!=='ENOENT')throw error;}
const {BgeEncoder}=await import('../dist/embedding/bge.js');
const {makeInstallation}=await import('../dist/storage/installation.js');
const {SCHEMA_VERSION}=await import('../dist/storage/database.js');
const profile=await new BgeEncoder({model_dir:source,dtype:'fp32',threads:2}).profile();
const model=join(root,'models/bge-small-zh-v1.5'),manifest=join(root,'installation.json'),maintenance=join(root,'recovery');
await mkdir(root,{recursive:true,mode:0o700});await cp(source,model,{recursive:true,errorOnExist:true,force:false});
const version=JSON.parse(await readFile(join(code,'package.json'),'utf8')).version;
const git=spawnSync('git',['rev-parse','HEAD'],{cwd:code,encoding:'utf8'});
const installation=await makeInstallation({source:code,runtime:code,data:root,database:join(root,'memory.db'),model_dir:model,
  maintenance_state:maintenance,node:await realpath(process.execPath),version,schema:SCHEMA_VERSION,
  commit:git.status===0?git.stdout.trim():null,model_profile:profile.id});
const identity=option('project-id');
const init=spawnSync(process.execPath,[join(code,'dist/cli/main.js'),'init','--root',root,'--model',model,'--manifest',manifest,
  '--maintenance-state',maintenance,'--project',project,'--name',project.split('/').at(-1),...(identity?['--project-id',identity]:[])],{encoding:'utf8'});
if(init.status!==0)throw Error(init.stderr);
await writeFile(manifest,JSON.stringify(installation,null,2)+'\n',{mode:0o600,flag:'wx'});
const installed=JSON.parse(init.stdout),output=join(root,'client-configs');
for(const [profile,config]of [['read-only',installed.config],['project-rw',installed.project_config],
  ['project-forget',installed.project_forget_config],['admin',installed.admin_config]]){
 const generated=spawnSync(process.execPath,[join(code,'scripts/client-configs.mjs'),'--config',config,'--project-id',installed.project_id,'--project',project,'--output',join(output,profile)],{encoding:'utf8'});
 if(generated.status!==0)throw Error(generated.stderr);
}
console.log(JSON.stringify({installed,manifest,service_directory:code,work_project:project,templates:output,default_templates:join(output,'read-only')},null,2));
