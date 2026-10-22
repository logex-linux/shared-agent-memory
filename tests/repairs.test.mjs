import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rm,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {MemoryService,readConfig} from '../dist/core/service.js';
import {setup,record,publish,MODEL} from './helpers.mjs';
const run=(script,args)=>spawnSync(process.execPath,[resolve(script),...args],{encoding:'utf8'});

test('P0 identifier boost retains paraphrases; exact_only is explicit',async()=>{
 const {service:s,project}=await setup({semantic_threshold:0.425});
 try{
  const semantic=await publish(s,record(project,{title:'数据库并发写入经验',content:'数据库出现写锁竞争时缩短事务，把编码和网络请求移到事务外，并对忙错误设置有界重试。'}));
  const literal=await publish(s,record(project,{title:'错误码登记',content:'SQLITE_BUSY 是一个登记过的代码标签，此处没有记录处理办法。'}));
  const query='以前处理 SQLITE_BUSY 并发故障时有什么经验？';
  const ordinary=await s.recall({query});assert.ok(ordinary.items.some(r=>r.id===semantic.memory_id));assert.ok(ordinary.items.some(r=>r.id===literal.memory_id));
  const exact=await s.recall({query,exact_only:true});assert.deepEqual(exact.items.map(r=>r.id),[literal.memory_id]);
  assert.deepEqual((await s.recall({query,exact_only:true},'vector')).items.map(r=>r.id),[literal.memory_id]);
  await assert.rejects(s.recall({query:'数据库忙怎么办',exact_only:true}),{code:'EXACT_IDENTIFIER_REQUIRED'});
 }finally{s.close();}
});

test('P0 object, exported array and raw bodies all require external revocations; old data stays forgotten',async()=>{
 const a=await setup(),b=await setup();
 try{
  const forgotten=await publish(a.service,record(a.project,{content:'旧备份中已经遗忘的独特内容。',import_key:'restore:forgotten'}));
  await publish(a.service,record(a.project,{content:'没有导入键的旧正文。'}));
  const retained=await publish(a.service,record(a.project,{content:'仍应恢复的独特内容。',import_key:'restore:retained'}));
  const naked=a.service.db.prepare("SELECT id FROM memories WHERE json_extract(body,'$.content')=?").get('没有导入键的旧正文。').id;
  const exported=await a.service.export(a.project),data=JSON.parse(await readFile(exported.path,'utf8'));
  await a.service.forget({request_id:randomUUID(),memory_id:forgotten.memory_id,expected_revision:1});
  await a.service.forget({request_id:randomUUID(),memory_id:naked,expected_revision:1});
  b.config.allowed_projects.push(a.project);b.service.config.allowed_projects.push(a.project);await b.service.project(a.project,'source',a.root);
  const config=join(b.root,'config.json');await writeFile(config,JSON.stringify(b.config));
  for(const [i,input]of [data,data.memories,data.memories.map(e=>e.record)].entries()){
   const path=join(b.root,`restore-${i}.json`);await writeFile(path,JSON.stringify(input));
   const missing=run('dist/cli/main.js',['import','--config',config,'--input',path,'--commit','--mode','restore']);assert.equal(missing.status,1);assert.match(missing.stderr,/LATEST_REVOCATIONS_REQUIRED/);
   if(i<2){const invalid=run('dist/cli/main.js',['import','--config',config,'--input',path,'--commit','--mode','new']);assert.equal(invalid.status,1);assert.match(invalid.stderr,/RESTORE_METADATA_NOT_ALLOWED/);}
   else {const fresh=run('dist/cli/main.js',['import','--config',config,'--input',path,'--commit','--mode','new']);assert.equal(fresh.status,1);assert.match(fresh.stderr,/LATEST_REVOCATIONS_REQUIRED/);}
  }
  await assert.rejects(b.service.importEntry(data.memories[0]),{code:'LATEST_REVOCATIONS_REQUIRED'});
  const path=join(b.root,'restore-1.json'),args=['import','--config',config,'--input',path,'--commit','--mode','restore','--revocations',join(a.root,'revocations.jsonl')];
  const restored=run('dist/cli/main.js',args);assert.equal(restored.status,0,restored.stderr);
  assert.equal((await b.service.recall({ids:[forgotten.memory_id]})).items.length,0);
  assert.equal((await b.service.recall({ids:[retained.memory_id]})).items[0].revision,1);
  const rawArgs=[...args];rawArgs[4]=join(b.root,'restore-2.json');const raw=run('dist/cli/main.js',rawArgs);assert.equal(raw.status,0,raw.stderr);
  assert.ok(!JSON.stringify(b.service.db.prepare('SELECT body FROM memories').all()).includes('没有导入键的旧正文'));
  assert.equal((await b.service.recall({query:'旧备份中已经遗忘的独特内容。'})).items.some(i=>i.content.includes('已经遗忘的独特内容')),false);
 }finally{a.service.close();b.service.close();}
});

test('P1 readonly permissions, server identity and verification authority are independent of model labels',async()=>{
 const {service:s,config,project}=await setup({connection_id:'admin:test',operations:['recall','propose','commit','forget','manage','verify']});
 const reader=new MemoryService({...config,connection_id:'reader:test',operations:['recall']}),writer=new MemoryService({...config,allowed_projects:[project],all_projects:false,allow_global:false,connection_id:'writer:test',operations:['recall','propose','commit','forget']});
 try{
  await assert.rejects(reader.propose({request_id:randomUUID(),record:record(project)}),{code:'OPERATION_DENIED'});
  await assert.rejects(reader.commit({request_id:randomUUID(),proposal_id:randomUUID(),expected_revision:0}),{code:'OPERATION_DENIED'});
  await assert.rejects(reader.forget({request_id:randomUUID(),memory_id:randomUUID(),expected_revision:1}),{code:'OPERATION_DENIED'});
  await assert.rejects(writer.propose({request_id:randomUUID(),record:record(null)}),{code:'SCOPE_DENIED'});
  await assert.rejects(reader.maintenance(),{code:'OPERATION_DENIED'});
  await assert.rejects(writer.propose({request_id:randomUUID(),record:record(project,{verification:{method:'claimed',summary:'filled fields',status:'verified',basis:'user_confirmation',evidence:'claim',reviewer:'forged-admin'}})}),{code:'OPERATION_DENIED'});
  for(const verification of [{status:'verified',basis:'document_review'},{status:'verified',basis:'model_inference',evidence:'A model guessed this.'}])await assert.rejects(s.propose({request_id:randomUUID(),record:record(project,{verification:{method:'claim',summary:'not reviewed',...verification}})}),{code:'VERIFICATION_EVIDENCE_REQUIRED'});
  const m=await publish(writer,record(project,{author_client:'forged-admin',verification:{method:'claimed verified',summary:'source says checked',reviewer:'forged-admin'}}));
  let item=(await reader.recall({ids:[m.memory_id]})).items[0];assert.equal(item.author_client,'forged-admin');assert.equal(item.written_by,'writer:test');assert.equal(item.verification.status,'unverified');assert.equal(item.verification.reviewer,undefined);
  const event=writer.db.prepare("SELECT connection_id FROM events WHERE operation='commit' AND json_extract(result,'$.memory_id')=?").get(m.memory_id);assert.equal(event.connection_id,'writer:test');
  const verified=await publish(s,record(project,{verification:{method:'human review',summary:'Reviewed statement',status:'verified',basis:'document_review',evidence:'Operator checked the document against the statement.',reviewer:'forged'}}),{target_id:m.memory_id,expected_revision:1});
  item=(await reader.recall({ids:[verified.memory_id]})).items[0];assert.equal(item.verification.status,'verified');assert.equal(item.verification.reviewer,'admin:test');assert.ok(item.verification.reviewed_at);
  const disputed=await publish(writer,record(project,{verification:{method:'counterevidence',summary:'needs review',status:'disputed',basis:'model_inference',evidence:'Conflicting historical statements.'}}),{target_id:m.memory_id,expected_revision:2});
  assert.equal((await reader.recall({ids:[disputed.memory_id]})).items[0].verification.status,'disputed');
 }finally{reader.close();writer.close();s.close();}
});

test('P1 migration keeps legacy records unverified and marks unknown writer honestly',async()=>{
 const {service:s,config,project}=await setup();const m=await publish(s,record(project));
 s.db.exec("ALTER TABLE memories DROP COLUMN written_by; ALTER TABLE proposals DROP COLUMN connection_id; ALTER TABLE events DROP COLUMN connection_id; PRAGMA user_version=3;");
 const row=s.db.prepare('SELECT body FROM memories WHERE id=?').get(m.memory_id),body=JSON.parse(row.body);body.verification={method:'legacy claims checked',summary:'Old metadata'};s.db.prepare('UPDATE memories SET body=? WHERE id=?').run(JSON.stringify(body),m.memory_id);s.close();
 const reopened=new MemoryService(config);try{const item=(await reopened.recall({ids:[m.memory_id]})).items[0];assert.equal(item.verification.status,'unverified');assert.equal(item.written_by,'legacy:unknown');assert.equal(reopened.inspect().schema,4);assert.equal(reopened.check().integrity[0].integrity_check,'ok');}finally{reopened.close();}
});

test('P1 readonly MCP exposes only recall and rejects hidden write tools',async()=>{
 const {service:s,config,root}=await setup();s.close();const path=join(root,'reader.json');await writeFile(path,JSON.stringify({...config,operations:['recall'],connection_id:'reader:wire'}));
 const c=new Client({name:'self-declared-admin',version:'test'});await c.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/mcp/server.js')],env:{SHARED_MEMORY_CONFIG:path},stderr:'pipe'}));
 try{assert.deepEqual((await c.listTools()).tools.map(t=>t.name),['memory_recall']);assert.match(c.getInstructions(),/reader:wire/);const denied=await c.callTool({name:'memory_forget',arguments:{request_id:randomUUID(),memory_id:randomUUID(),expected_revision:1}});assert.equal(denied.isError,true);}finally{await c.close();}
});

test('P2 installer separates work directory; profiles and Codex mapping select actual UUID',async()=>{
 const {root,service:s,project,other,config}=await setup();s.close();
 const missing=run('scripts/install-local.mjs',['--root',join(root,'bad')]);assert.notEqual(missing.status,0);assert.match(missing.stderr,/WORK_PROJECT_REQUIRED/);
 const work=join(root,'actual-work');await mkdir(work);
 const installed=run('dist/cli/main.js',['init','--root',join(root,'installation'),'--model',MODEL,'--project',work]);assert.equal(installed.status,0,installed.stderr);const result=JSON.parse(installed.stdout);
 const reader=await readConfig(result.config),writer=await readConfig(result.project_config),admin=await readConfig(result.admin_config);
  assert.deepEqual(result.aliases,[await realpath(work)]);
 assert.deepEqual(reader.operations,['recall']);assert.equal(writer.all_projects,false);assert.equal(writer.allow_global,false);assert.deepEqual(writer.allowed_projects,[result.project_id]);assert.ok(admin.operations.includes('verify'));
 const path=join(root,'multi.json');await writeFile(path,JSON.stringify(config));const output=join(root,'templates');
 const noSelection=run('scripts/client-configs.mjs',['--config',path,'--output',output]);assert.notEqual(noSelection.status,0);assert.match(noSelection.stderr,/PROJECT_SELECTION_REQUIRED/);
 const selected=run('scripts/client-configs.mjs',['--config',path,'--project-id',other,'--project',join(root,'other'),'--output',output]);assert.equal(selected.status,0,selected.stderr);assert.equal(JSON.parse(selected.stdout).project_id,other);const rules=await readFile(join(output,'project-rules.md'),'utf8');assert.ok(rules.includes(other));assert.ok(!rules.includes(project));
 const mismatch=run('scripts/client-configs.mjs',['--config',path,'--project-id',project,'--project',join(root,'other'),'--output',output]);assert.notEqual(mismatch.status,0);
 await rm(join(root,'other'),{recursive:true});const stale=run('scripts/client-configs.mjs',['--config',path,'--project-id',other,'--output',output]);assert.notEqual(stale.status,0);assert.match(stale.stderr,/PROJECT_ALIAS_STALE_OR_MISMATCH/);
});
