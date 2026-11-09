import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { copyFile,mkdir,mkdtemp,readFile,realpath,writeFile } from 'node:fs/promises';
import { dirname,join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync,backup } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MemoryService } from '../../dist/core/service.js';
import { BgeEncoder } from '../../dist/embedding/bge.js';

const [output,sourceFile,ledgerFile,legacyDist]=process.argv.slice(2);
if(!output||!sourceFile||!ledgerFile||!legacyDist)
  throw Error('Usage: rehearse.mjs EXISTING_OUTPUT_DIRECTORY SOURCE_SCHEMA5_DB LATEST_REVOCATIONS_JSONL BASELINE_DIST');
const root=await mkdtemp(join(await realpath(output),'rehearsal-'));
const legacy=resolve(legacyDist),runtime=resolve('dist');
const {MemoryService:Legacy}=await import(pathToFileURL(join(legacy,'core/service.js')));
const {version}=JSON.parse(await readFile('package.json','utf8'));
const ledger=await readFile(ledgerFile,'utf8');
const revocations=ledger.split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));
const project=randomUUID(),node=process.execPath;
const model_dir=resolve('.local/models/bge-small-zh-v1.5');
const encoder=new BgeEncoder({model_dir,dtype:'fp32',threads:2});
const base={model_dir,allowed_projects:[project],all_projects:true,allow_global:true,
  operations:['recall','propose','commit','forget','manage','verify'],connection_id:'isolated-v1-rehearsal'};
const digest=value=>createHash('sha256').update(value).digest('hex');
const report={root,source_open:'read-only',ledger_sha256:digest(ledger),ledger_entries:revocations.length,clients:[]};
function open(path){
  const db=new DatabaseSync(path,{readOnly:true,allowExtension:true});
  sqliteVec.load(db);
  return db;
}
function signed(db){
  return Object.fromEntries(['memories','memory_chunks','memory_vec','embedding_profiles','events','dependencies','memory_search',
    'chunk_fts','chunk_identifiers','tombstones','projects'].map(table=>{
    const h=createHash('sha256');
    const columns=table==='memory_search'?'memory_id,project_id,scope,revision,status,profile_id,branch,commit_ref,environment,expires_at,metadata':'*';
    for(const row of db.prepare('SELECT '+columns+' FROM '+table+' ORDER BY 1,2').iterate()){
      for(const value of Object.values(row)){
        const data=value instanceof Uint8Array?value:Buffer.from(JSON.stringify(value));
        h.update(Buffer.from(String(data.length)+':'));
        h.update(data);
      }
      h.update('\n');
    }
    return [table,h.digest('hex')];
  }));
}
function privateConfig(database,overrides={}){
  assert.equal(dirname(resolve(database)),root);
  return {...base,database,...overrides};
}
function run(args){
  const result=spawnSync(node,args,{encoding:'utf8',env:{...process.env,SHARED_MEMORY_CONFIG:''}});
  assert.equal(result.status,0,result.stderr);
  return result.stdout.trim();
}
async function publish(service,record,previous){
  const p=await service.propose({request_id:randomUUID(),record,
    ...(previous&&{target_id:previous.memory_id,expected_revision:previous.revision})});
  return service.commit({request_id:randomUUID(),proposal_id:p.proposal_id,expected_revision:p.expected_revision});
}
async function call(definition,expectedVersion,record,versions=false){
  const transport=new StdioClientTransport({...definition,stderr:'pipe'});
  const client=new Client({name:'isolated-switch-probe',version:'1'});
  try{
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version,expectedVersion);
    const names=(await client.listTools()).tools.map(tool=>tool.name).sort();
    assert.deepEqual(names,['memory_commit','memory_propose','memory_recall']);
    const result=await client.callTool({name:'memory_recall',arguments:versions?
      {versions:[{memory_id:record.memory_id,revision:record.revision}]}:{ids:[record.memory_id]}});
    assert.equal(result.isError,undefined);
    const item=JSON.parse(result.content[0].text).items[0];
    assert.equal(item.id,record.memory_id);
    assert.equal(item.revision,record.revision);
    return {version:expectedVersion,tools:names,revision:item.revision};
  }finally{await client.close();}
}
async function readLaunchers(output){
  const launchers=[];
  for(const name of ['codex.config.toml','stepcode.config.toml','claude.mcp.json','pi.mcp.json','dsh.cordis.patch.yml','hermes.config.yaml']){
    const data=await readFile(join(output,name),'utf8');
    let definition;
    if(name.endsWith('.json')){
      const {command,args,env}=JSON.parse(data).mcpServers.shared_memory;
      definition={command,args,env};
    }else{
      const field=key=>JSON.parse(data.match(new RegExp('^\\s*'+key+'\\s*[:=]\\s*(.+)$','m'))[1]);
      definition={command:field('command'),args:field('args'),env:{SHARED_MEMORY_CONFIG:field('SHARED_MEMORY_CONFIG')}};
    }
    launchers.push({name,definition});
  }
  return launchers;
}

const snapshot=join(root,'source-copy.db');
const source=open(sourceFile);
try{
  source.exec('BEGIN');
  assert.equal(source.prepare('PRAGMA user_version').get().user_version,5);
  report.source_schema=5;
  report.source_records=source.prepare('SELECT count(*) n FROM memories').get().n;
  report.signature=signed(source);
  await backup(source,snapshot);
  source.exec('COMMIT');
}finally{source.close();}
const cloned=open(snapshot);
try{assert.deepEqual(signed(cloned),report.signature);}finally{cloned.close();}

for(const boundary of ['before_commit','after_commit']){
  const database=join(root,'interrupt-'+boundary+'.db');
  await copyFile(snapshot,database);
  const configPath=join(root,boundary+'.json');
  await writeFile(configPath,JSON.stringify(privateConfig(database)),{mode:0o600});
  const killed=spawnSync(node,['tests/process-worker.mjs',configPath,'crash','migration:'+boundary],{encoding:'utf8'});
  assert.equal(killed.signal,'SIGKILL',killed.stderr);
  const db=open(database);
  try{
    assert.deepEqual(signed(db),report.signature);
    const schema=db.prepare('PRAGMA user_version').get().user_version;
    assert.equal(schema,boundary==='before_commit'?5:11);
    report[boundary]={signal:killed.signal,schema,signature_equal:true};
  }finally{db.close();}
}

const upgraded=join(root,'migrated.db');
await copyFile(snapshot,upgraded);
let migrated=new MemoryService(privateConfig(upgraded),encoder);
try{
  assert.deepEqual(signed(migrated.db),report.signature);
  assert.equal(migrated.storage.schema(),11);
  assert.equal(migrated.db.prepare('SELECT count(*) n FROM memory_versions').get().n,report.source_records);
}finally{migrated.close();}
migrated=new MemoryService(privateConfig(upgraded),encoder);
try{
  assert.deepEqual(signed(migrated.db),report.signature);
  assert.equal(migrated.check().missing_version_dependencies.n,0);
  report.reopen={schema:migrated.storage.schema(),signature_equal:true};
  assert.throws(()=>new Legacy(privateConfig(upgraded)),{code:'SCHEMA_TOO_NEW'});
  report.legacy_open='SCHEMA_TOO_NEW';
  const applied=await migrated.applyRevocations(revocations);
  for(let offset=0;offset<revocations.length;offset+=10){
    const batch=revocations.slice(offset,offset+10).map(entry=>entry.id);
    assert.deepEqual((await migrated.recall({ids:batch})).items,[]);
  }
  const checked=migrated.check();
  assert.equal(checked.integrity[0].integrity_check,'ok');
  report.revocations={applied:applied.revocations_applied,returned:0,integrity:'ok'};
}finally{migrated.close();}

const sourceDB=join(root,'client-before.db'),clientDB=join(root,'client-after.db');
const sourceRecord={project_id:project,scope:'project',kind:'procedure',title:'SAM_REHEARSAL_V1',
  content:'SAM_REHEARSAL_V1 confirms the isolated version switch.',
  sources:[{source_type:'test',uri:'test://v1/migration/rehearsal',locator:'isolated CLI and MCP record',
    revision_ref:'rehearsal-1',checked_at:new Date().toISOString()}],
  verification:{method:'isolated rehearsal',summary:'Synthetic record.'},author_client:'benchmark',author_session:'migration'};
const old=new Legacy(privateConfig(sourceDB),encoder);
let original;
try{
  await old.project(project,'isolated rehearsal project',root);
  original=await publish(old,sourceRecord);
  await backup(old.db,clientDB);
}finally{old.close();}
const clientOps={all_projects:false,allow_global:false,operations:['recall','propose','commit'],connection_id:'rehearsal:scoped-writer'};
const oldConfig=join(root,'client-old.json'),newConfig=join(root,'client-new.json');
await writeFile(oldConfig,JSON.stringify(privateConfig(sourceDB,clientOps)),{mode:0o600});
await writeFile(newConfig,JSON.stringify(privateConfig(clientDB,clientOps)),{mode:0o600});
const writer=new MemoryService(privateConfig(clientDB,clientOps),encoder);
let newer;
try{
  newer=await publish(writer,{...sourceRecord,content:'SAM_REHEARSAL_V1 confirms this newer isolated record.',memory_form:'procedural'},original);
  const fallback=await writer.recall({query:'SAM_REHEARSAL_V1',graph:true,project_id:project,limit:2});
  assert.equal(fallback.retrieval_mode,'hybrid');
  assert.ok(fallback.warnings.includes('GRAPH_DISABLED'));
  assert.equal(fallback.items[0].revision,newer.revision);
  const history=await writer.recall({versions:[{memory_id:original.memory_id,revision:original.revision}]});
  assert.equal(history.items[0].content,sourceRecord.content);
  report.compatibility_fallback={latest:newer.revision,history:history.items[0].revision};
}finally{writer.close();}
const generated=join(root,'launchers');
await mkdir(generated);
run(['scripts/client-configs.mjs','--config',newConfig,'--output',generated,'--project-id',project]);
for(const {name,definition} of await readLaunchers(generated)){
  assert.equal(definition.command,node);
  assert.deepEqual(definition.args,[join(runtime,'mcp/server.js')]);
  assert.equal(definition.env.SHARED_MEMORY_CONFIG,newConfig);
  const before=await call({...definition,args:[join(legacy,'mcp/server.js')],env:{SHARED_MEMORY_CONFIG:oldConfig}},'0.4.8',original);
  const after=await call(definition,version,newer);
  await call(definition,version,original,true);
  report.clients.push({template:name,before,after,historical_revision:original.revision});
}
await writeFile(join(root,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({root,source_records:report.source_records,schema:report.reopen.schema,legacy_open:report.legacy_open,
  revocations:report.revocations,templates:report.clients.length,compatibility_fallback:report.compatibility_fallback},null,2));
