import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID}from'node:crypto';import{writeFile}from'node:fs/promises';import{resolve}from'node:path';
import{Client}from'@modelcontextprotocol/sdk/client/index.js';import{StdioClientTransport}from'@modelcontextprotocol/sdk/client/stdio.js';
import{referenceEvidence,evidenceWindow,focusTerms}from'../dist/retrieval/evidence.js';import{setup,record,publish}from'./helpers.mjs';
const v=new Float32Array(512);v[0]=1;const encoder={profile:async()=>({id:'context-test',manifest:{synthetic:true}}),query:async()=>v,chunks:async(_,text)=>[{text,start:0,end:text.length,tokens:text.length,vector:v}]};
test('focused reference evidence distinguishes dates, code symbols, mixed project names and absolute path suffixes',()=>{
 assert.equal(referenceEvidence('2026 20261027 2026-10-27')('记录于2026年。').count,0);
 assert.equal(referenceEvidence('ERR_BUSY')('ERR_BUSY_EXTRA only.').coverage,0);
 assert.equal(referenceEvidence('src/lib/state.ts')('Changed /work/src/lib/state.ts.').coverage,1);
 assert.equal(referenceEvidence('ZX204 ZX205')('No coursework here.').coverage,0);
 assert.equal(referenceEvidence('ZX_个人课程_20261027')('Other course notes.').count,1);
 assert.equal(referenceEvidence('-67050')('Error -67050.').coverage,1);
});
test('English query scaffolding cannot displace the original evidence sentence',()=>{
 const query='What exactly was the prior fix for cache corruption and why should it be preserved?';
 assert.ok(!focusTerms(query).includes('the'));assert.ok(!focusTerms(query).includes('should'));
 const text='What was the previous work that should be kept? '.repeat(15)+'The team fixed cache corruption by validating the checksum.';
 const w=evidenceWindow(text,query);assert.ok(w.text.includes('validating the checksum'));assert.equal(w.text,text.slice(w.start,w.end));
});
test('a generic filename hit remains accessible background for a different named system, not supporting evidence',async()=>{
 const {service:s,project}=await setup();s.encoder=encoder;
 try{
  const saved=await publish(s,record(project,{title:'Legacy attendance app',content:'Legacy attendance system updated app.js and app.css.',tags:['legacy']}));
  const input={query:'ZX_课程系统_20261027 app.js lesson_path exercise_path answer_path',mode:'focused',view:'evidence',debug:true};
  const r=await s.recall(input);assert.ok(r.items.some(i=>i.id===saved.memory_id));assert.equal(r.evidence_status,'insufficient');assert.ok(r.items.every(i=>i.evidence_strength==='weak'&&i.recall_reason.includes('background_only')));assert.ok(r.warnings.includes('REFERENCE_EVIDENCE_MISSING'));assert.equal(r.diagnostics.full_body_records_read,0);
  const full=await s.recall({ids:[saved.memory_id]});assert.equal(full.items[0].content,'Legacy attendance system updated app.js and app.css.');
  const broad=await s.recall({...input,mode:'broad'});assert.equal(broad.items[0].evidence_strength,'supported');assert.ok(!broad.warnings.includes('REFERENCE_EVIDENCE_MISSING'));
  const direct=await publish(s,record(project,{title:'New learning system',content:'ZX_课程系统_20261027 app.js consumes lesson_path, exercise_path and answer_path.'}));
  const ranked=await s.recall(input);assert.equal(ranked.items[0].id,direct.memory_id);assert.equal(ranked.items[0].evidence_strength,'supported');
 }finally{s.close();}
});
test('an unmatched symbol does not remove a semantically relevant local subject with direct evidence',async()=>{
 const {service:s,project}=await setup();s.encoder=encoder;
 try{
  const saved=await publish(s,record(project,{title:'稳定签名录屏授权修复',content:'稳定签名解决录屏授权失效，需要重新授予屏幕录制权限。'}));
  const r=await s.recall({query:'ERR_NOT_STORED 稳定签名录屏授权修复',mode:'focused',view:'evidence'});assert.equal(r.items[0].id,saved.memory_id);assert.equal(r.items[0].evidence_strength,'supported');
  const semantic=await s.recall({query:'ERR_NOT_STORED 帧缓冲许可故障',mode:'focused'});assert.ok(semantic.items.some(i=>i.id===saved.memory_id));
 }finally{s.close();}
});
test('MCP reports the actual query/cursor constraint without changing the error code',async()=>{
 const {service:s,config,root}=await setup();s.close();const path=root+'/reader.json';await writeFile(path,JSON.stringify({...config,operations:['recall']}));
 const c=new Client({name:'cursor-guidance',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/mcp/server.js')],env:{SHARED_MEMORY_CONFIG:path},stderr:'pipe'}));
 try{const r=await c.callTool({name:'memory_recall',arguments:{query:'topic',cursor:'am4:invalid:1'}});assert.ok(r.isError);const error=JSON.parse(r.content[0].text).error;assert.equal(error.code,'INVALID_INPUT');assert.ok(error.fields.some(f=>f.message==='exactly one of query, ids or cursor required'));}finally{await c.close();}
});
