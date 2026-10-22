import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { setup,record } from './helpers.mjs';
test('official SDK STDIO: schemas, instructions, cross-process updates, restart, forget (not C01)',async()=>{
  const {service:s,root,config,project}=await setup();s.close();const path=root+'/config.json';await writeFile(path,JSON.stringify(config));
  async function connect(name){const client=new Client({name,version:'test'});await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/mcp/server.js')],env:{SHARED_MEMORY_CONFIG:path},stderr:'pipe'}));return client;}
  let a=await connect('sdk-a'),b=await connect('sdk-b');
  async function call(client,name,args){const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);}
  try{
    const tools=(await a.listTools()).tools;
    assert.equal(tools.length,4);assert.ok(a.getInstructions().includes(project));
    assert.ok(!tools.find(t=>t.name==='memory_recall').inputSchema.required?.includes('project_id'));
    const p=await call(a,'memory_propose',{request_id:randomUUID(),record:record(project)});
    const m=await call(a,'memory_commit',{request_id:randomUUID(),proposal_id:p.proposal_id,expected_revision:0});
    let found=await call(b,'memory_recall',{query:'录屏授权为什么坏了'});assert.equal(found.items[0].id,m.memory_id);
    const u=await call(b,'memory_propose',{request_id:randomUUID(),record:record(project,{content:'更新后必须重新检查签名身份。'}),target_id:m.memory_id,expected_revision:1});
    await call(b,'memory_commit',{request_id:randomUUID(),proposal_id:u.proposal_id,expected_revision:1});
    await a.close();a=await connect('sdk-a-restart');found=await call(a,'memory_recall',{project_id:project,ids:[m.memory_id]});assert.equal(found.items[0].revision,2);
    await call(a,'memory_forget',{request_id:randomUUID(),memory_id:m.memory_id,expected_revision:2});
    assert.equal((await call(b,'memory_recall',{project_id:project,ids:[m.memory_id]})).items.length,0);
    const bad=await b.callTool({name:'memory_recall',arguments:{project_id:randomUUID(),query:'x'}});assert.equal(bad.isError,true);
  }finally{await a.close();await b.close();}
});

test('official SDK exposes adaptive pagination and compact sourced evidence without granting write operations',async()=>{
 const {fake,seed}=await import('./adaptive-helpers.mjs');const {service:s,root,config,project}=await setup();s.encoder=fake;const gold=seed(s,[project],61);s.close();const path=root+'/adaptive-reader.json';await writeFile(path,JSON.stringify({...config,operations:['recall']}));
 const c=new Client({name:'adaptive-reader',version:'test'});await c.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/mcp/server.js')],env:{SHARED_MEMORY_CONFIG:path},stderr:'pipe'}));
 try{
  const tool=(await c.listTools()).tools[0];assert.equal(tool.name,'memory_recall');assert.ok(tool.inputSchema.properties.cursor);assert.deepEqual(tool.inputSchema.properties.mode.enum,['auto','focused','broad']);assert.ok(!tool.inputSchema.properties.limit.maximum||tool.inputSchema.properties.limit.maximum>1000);
  let request={query:'设计偏好',mode:'broad',view:'evidence',limit:9};const ids=[];do{const result=await c.callTool({name:'memory_recall',arguments:request});assert.ok(!result.isError,JSON.stringify(result));const r=JSON.parse(result.content[0].text);assert.equal(r.diagnostics,undefined);assert.ok(r.items.length<=9);assert.ok(r.items.every(i=>i.content.length<=200&&i.sources.length&&i.verification.status==='unverified'));ids.push(...r.items.map(i=>i.id));if(!r.has_more)break;request={cursor:r.next_cursor};}while(true);
  assert.equal(new Set(ids).size,ids.length);assert.deepEqual(new Set(ids),new Set(gold));assert.match(c.getInstructions(),/heuristic/);
 }finally{await c.close();}
});
