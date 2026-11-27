// Stage a reproducible build and a consistent backup. Activate only after rehearsal.
import {execFileSync} from 'node:child_process';
import {chmod,cp,mkdir,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
import {artifactHash,makeInstallation,readInstallation} from '../dist/storage/installation.js';
import {SCHEMA_VERSION} from '../dist/storage/database.js';

function findLiveMcpProcesses(runtimeDir) {
  if (process.platform === 'win32') return [];
  try {
    const target = join(runtimeDir, 'dist/mcp/server.js');
    const out = execFileSync('ps', ['-eo', 'pid=,lstart=,args='], { encoding: 'utf8' });
    const hits = [];
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes(target)) continue;
      const match = /^(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(trimmed);
      if (match) hits.push({ pid: Number(match[1]), started: match[2], command: match[3] });
      else hits.push({ raw: trimmed });
    }
    return hits;
  } catch {
    return [];
  }
}

const args=process.argv.slice(2),option=name=>args[args.indexOf('--'+name)+1];
if(args.length!==4||!args.includes('--manifest')||!args.includes('--output'))
  throw Error('Usage: upgrade-local.mjs --manifest INSTALLED_MANIFEST --output NEW_DIRECTORY');
const installed=await readInstallation(resolve(option('manifest'))),output=resolve(option('output'));
if(process.version!=='v24.18.0'||installed.node!==await realpath(process.execPath))throw Error('INSTALLATION_NODE_MISMATCH');
if(await artifactHash(installed.runtime)!==installed.artifacts_sha256)throw Error('INSTALLATION_ARTIFACT_MISMATCH');
const git=(...args)=>execFileSync('git',args,{cwd:installed.source,encoding:'utf8'}).trim();
if(git('status','--porcelain'))throw Error('UPGRADE_SOURCE_DIRTY');
const commit=git('rev-parse','HEAD'),version=JSON.parse(await readFile(join(installed.source,'package.json'),'utf8')).version;
const lock=async dir=>{
  const {packages}=JSON.parse(await readFile(join(dir,'package-lock.json'),'utf8'));
  delete packages[''].version;
  return JSON.stringify(packages);
};
if(await lock(installed.source)!==await lock(installed.runtime))throw Error('UPGRADE_DEPENDENCIES_CHANGED');
const npm=join(installed.node,'..','npm');
execFileSync(npm,['run','build'],{cwd:installed.source,env:{...process.env,PATH:join(installed.node,'..')+':'+process.env.PATH},stdio:'inherit'});
await mkdir(output,{mode:0o700});
try {
  const runtime=join(output,'runtime'),data=join(output,'backup'),database=join(data,'memory.db');
  await mkdir(runtime,{mode:0o700});await mkdir(data,{mode:0o700});
  const files=['revocations.jsonl','maintenance.json'];
  const readState=async file=>{
    try {return await readFile(join(installed.maintenance_state,file));}
    catch(error) {
      if(installed.schema<13&&file==='maintenance.json'&&error.code==='ENOENT')
        return Buffer.from('{"format":"shared-agent-memory/maintenance-v1","entries":[]}\n');
      throw error;
    }
  };
  const state=await Promise.all(files.map(readState));
  const db=new DatabaseSync(installed.database,{readOnly:true});
  try {await backup(db,database);}
  finally {db.close();}
  const check=new DatabaseSync(database,{readOnly:true});
  try {
    if(Number(check.prepare('PRAGMA user_version').get().user_version)!==installed.schema)throw Error('INSTALLATION_SCHEMA_MISMATCH');
    const pending=check.prepare("SELECT key FROM meta WHERE key IN ('revocations_pending','maintenance_pending','recovery_pending') AND value<>0").all();
    if(pending.length)throw Error('UPGRADE_MAINTENANCE_PENDING');
  } finally {check.close();}
  const after=await Promise.all(files.map(readState));
  if(after.some((bytes,i)=>!bytes.equals(state[i])))throw Error('UPGRADE_LEDGER_CHANGED_RETRY');
  await chmod(database,0o600);
  for(const [i,file] of files.entries())await writeFile(join(data,file),state[i],{mode:0o600,flag:'wx'});
  for(const file of ['dist','package.json','package-lock.json'])
    await cp(join(installed.source,file),join(runtime,file),{recursive:true,errorOnExist:true,force:false});
  await symlink(join(installed.runtime,'node_modules'),join(runtime,'node_modules'),'dir');
  const candidate=await makeInstallation({...installed,runtime,version,commit,schema:SCHEMA_VERSION});
  await writeFile(join(output,'installed.json'),JSON.stringify(installed,null,2)+'\n',{mode:0o600});
  await writeFile(join(output,'candidate.json'),JSON.stringify(candidate,null,2)+'\n',{mode:0o600});
  const live_mcp_processes=findLiveMcpProcesses(installed.runtime);
  const restart_warning=live_mcp_processes.length
    ? 'Restart or reload running MCP clients so live server.js processes pick up the upgraded dist and schemas.'
    : undefined;
  if(restart_warning)console.error(`WARNING: ${restart_warning} (${live_mcp_processes.length} live process(es))`);
  console.log(JSON.stringify({output,database,runtime,commit,version,schema:SCHEMA_VERSION,live_mcp_processes,...(restart_warning&&{restart_warning})}));
} catch(error) {
  await rm(output,{recursive:true,force:true});
  throw error;
}
