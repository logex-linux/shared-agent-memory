import test from 'node:test';import assert from 'node:assert/strict';
import {setup,record,publish} from './helpers.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {randomUUID} from 'node:crypto';import {writeFile} from 'node:fs/promises';import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const vector=(cos=1)=>{const v=new Float32Array(512);v[0]=cos;v[1]=Math.sqrt(1-cos*cos);return v;};
const encoder={profile:async()=>({id:'audit-vector',manifest:{synthetic:true}}),query:async()=>vector(),chunks:async(title,text)=>[{text,start:0,end:text.length,tokens:text.length,vector:vector(title.startsWith('共享')?.72:.52)}]};
const collect=async(s,input)=>{const pages=[];do{const r=await s.recall(input);pages.push(r);if(!r.has_more)break;input={cursor:r.next_cursor};}while(true);return pages;};
test('source-category tags and common historical scaffolding do not substitute for focused subject evidence',async()=>{
 const {service:s,project}=await setup({semantic_threshold:.425});s.encoder=encoder;
 try{
  const gold=await publish(s,record(project,{title:'共享记忆写入授权',content:'共享记忆写入授权：只有明确请求保存才发布新记忆。',tags:['imported','history'],sources:[{source_type:'test',uri:'test://fixtures/history.md',locator:'policy',revision_ref:'1',checked_at:new Date().toISOString()}]}));
  for(let i=0;i<12;i++)await publish(s,record(project,{title:'课程录屏授权记录'+i,content:'历史记忆：课程笔记、录屏授权、写作方法，已入库。',tags:['imported','history'],sources:[{source_type:'test',uri:'test://fixtures/history.md',locator:'unrelated '+i,revision_ref:'1',checked_at:new Date().toISOString()}]}));
  const pages=await collect(s,{query:'共享记忆写入授权',mode:'focused',view:'evidence',debug:true});
  assert.deepEqual(pages.flatMap(p=>p.items.map(i=>i.id)),[gold.memory_id]);assert.ok(pages.every(p=>p.diagnostics.full_body_records_read===0));
  const semantic=await s.recall({query:'CODE_NOT_LISTED 共享记忆的写入授权',mode:'focused'});assert.equal(semantic.items[0].id,gold.memory_id);
 }finally{s.close();}
});
test('a year alone does not certify relevance to an unrelated subject; explicit identifier lookup retains it',async()=>{
 const {service:s,project}=await setup({semantic_threshold:.425});s.encoder=encoder;
 try{
  for(let i=0;i<5;i++)await publish(s,record(project,{title:'2026课程登记'+i,content:'2026 年课程笔记与出版清单。',tags:['imported','history'],sources:[{source_type:'test',uri:'test://fixtures/history.md',locator:'course '+i,revision_ref:'1',checked_at:new Date().toISOString()}]}));
  const absent=await collect(s,{query:'2026 火星矿场风暴预警',mode:'focused'});assert.ok(absent.every(p=>p.items.length===0&&p.evidence_status==='insufficient'));
  const exact=await collect(s,{query:'2026 火星矿场风暴预警',mode:'focused',exact_only:true});assert.equal(exact.flatMap(p=>p.items).length,5);
  assert.equal((await collect(s,{query:'2026',mode:'focused'})).flatMap(p=>p.items).length,5);
 }finally{s.close();}
});
test('multiple distinctive subject matches retain complementary evidence within a long focused query',async()=>{
 const {service:s,project}=await setup({semantic_threshold:.425});s.encoder=encoder;
 try{
  const common={tags:['history'],sources:[{source_type:'test',uri:'test://fixtures/history.md',locator:'source',revision_ref:'1',checked_at:new Date().toISOString()}]};
  const gold=await publish(s,record(project,{...common,title:'联网操作记录',content:'OrbitSearch 与 OrbitFetch 是已选择的联网工具。'}));
  for(let i=0;i<4;i++)await publish(s,record(project,{...common,title:'专用浏览器记录'+i,content:'OrbitSearch 专用浏览器的窗口隐藏和授权。'}));
  const pages=await collect(s,{query:'用户已废弃 LegacyLookup，改用 OrbitSearch 和 OrbitFetch 的决定、配置入口与最近排错记录',mode:'focused'});
  assert.ok(pages.flatMap(p=>p.items).some(i=>i.id===gold.memory_id));
 }finally{s.close();}
});
test('default hybrid abstains rather than returning a forced weak fallback, while explicit lexical evidence remains available',async()=>{
 const {service:s,project}=await setup({semantic_threshold:.425});s.encoder={...encoder,query:async()=>vector(-1)};
 try{
  for(let i=0;i<3;i++)await publish(s,record(project,{title:'历史签名事项'+i,content:'历史记忆：签名事项。',tags:['history'],sources:[{source_type:'test',uri:'test://fixtures/history.md',locator:'case '+i,revision_ref:'1',checked_at:new Date().toISOString()}]}));
  const hybrid=await s.recall({query:'签名 火星 饼干 传送门',mode:'focused'});assert.equal(hybrid.items.length,0);assert.equal(hybrid.evidence_status,'insufficient');
  const lexical=await s.recall({query:'签名 火星 饼干 传送门'},'lexical');assert.equal(lexical.items.length,1);assert.equal(lexical.evidence_status,'insufficient');
 }finally{s.close();}
});
test('a compact ordinary page can use its actual byte budget without reserving absent debug diagnostics',async()=>{
 const {service:s,project}=await setup();s.encoder=encoder;
 try{
  const m=await publish(s,record(project,{title:'共享记忆短证据',content:'共享记忆授权保存。'+ '必要上下文。'.repeat(35)}));
  const r=await s.recall({query:'共享记忆授权',mode:'focused',view:'evidence',max_bytes:2048});assert.equal(r.items[0].id,m.memory_id);assert.ok(r.items[0].sources.length);assert.ok(r.items[0].content.length>0);assert.ok(Buffer.byteLength(JSON.stringify(r))<=2048);assert.equal(r.diagnostics,undefined);
 }finally{s.close();}
});
test('an explicitly selected writer exposes propose/commit without administrator or forget capabilities',async()=>{
 const {service:s,config,project,root}=await setup();s.close();const path=root+'/writer.json';await writeFile(path,JSON.stringify({...config,connection_id:'test:explicit-writer',operations:['recall','propose','commit']}));
 const c=new Client({name:'explicit-writer-test',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/mcp/server.js')],env:{SHARED_MEMORY_CONFIG:path},stderr:'pipe'}));
 const call=async(name,args)=>{const r=await c.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);};
 try{
  assert.deepEqual((await c.listTools()).tools.map(t=>t.name).sort(),['memory_commit','memory_propose','memory_recall']);
  const p=await call('memory_propose',{request_id:randomUUID(),record:record(project,{verification:{method:'explicit user instruction',summary:'Synthetic user confirmation',basis:'user_confirmation',status:'unverified'}})});const m=await call('memory_commit',{request_id:randomUUID(),proposal_id:p.proposal_id,expected_revision:0});const saved=(await call('memory_recall',{ids:[m.memory_id]})).items[0];assert.equal(saved.written_by,'test:explicit-writer');assert.equal(saved.verification.status,'unverified');assert.equal(saved.verification.basis,'user_confirmation');
  const bad=await c.callTool({name:'memory_propose',arguments:{request_id:randomUUID(),record:record(project,{verification:{method:'user confirmation',summary:'Cannot certify facts',basis:'user_confirmation',status:'verified'}})}});assert.equal(bad.isError,true);const denied=JSON.parse(bad.content[0].text).error;assert.equal(denied.code,'OPERATION_DENIED');assert.equal(denied.retryable,false);assert.equal(denied.required_operation,'verify');assert.match(denied.hint,/status=unverified/);
  const tools=(await c.listTools()).tools;assert.match(tools.find(t=>t.name==='memory_propose').description,/user_confirmation/);assert.match(tools.find(t=>t.name==='memory_propose').inputSchema.properties.record.properties.verification.properties.status.description,/separate verify permission/);
 }finally{await c.close();}
});
test('CLI distinguishes missing write permission from missing verification without persisting denied candidates',async()=>{
 const {service:s,config,project,root}=await setup();const input=root+'/input.json',path=root+'/client.json';
 const call=async(operations,verification)=>{await writeFile(path,JSON.stringify({...config,operations}));await writeFile(input,JSON.stringify({request_id:randomUUID(),record:record(project,{verification})}));const result=spawnSync(process.execPath,[resolve('dist/cli/main.js'),'propose','--config',path,'--input',input],{encoding:'utf8'});return {exit:result.status,value:JSON.parse(result.status===0?result.stdout:result.stderr.trim().split('\n').find(line=>line.startsWith('{')))};};
 const counts=()=>['proposals','events'].map(table=>s.db.prepare(`SELECT count(*) n FROM ${table}`).get().n);
 try{
  const before=counts(),unverified={method:'synthetic user instruction',summary:'Not privileged verification',basis:'user_confirmation',status:'unverified'};
  const readonly=await call(['recall'],unverified);assert.equal(readonly.exit,1);assert.equal(readonly.value.error,'OPERATION_DENIED');assert.equal(readonly.value.required_operation,'propose');assert.deepEqual(counts(),before);
  const denied=await call(['recall','propose','commit'],{...unverified,status:'verified'});assert.equal(denied.exit,1);assert.equal(denied.value.error,'OPERATION_DENIED');assert.equal(denied.value.required_operation,'verify');assert.match(denied.value.hint,/user_confirmation/);assert.deepEqual(counts(),before);
  const allowed=await call(['recall','propose','commit'],unverified);assert.equal(allowed.exit,0);assert.ok(allowed.value.proposal_id);assert.deepEqual(counts(),before.map(n=>n+1));
 }finally{s.close();}
});
