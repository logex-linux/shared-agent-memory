import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MemoryService } from '../dist/core/service.js';
import { decayWeight } from '../dist/memory/feedback.js';
import { QueryState } from '../dist/retrieval/state.js';
import { setupFake, fake } from './adaptive-helpers.mjs';
import { publish, record } from './helpers.mjs';

const cli=promisify(execFile);
const query={query:'SQLite rollback signing evidence',mode:'broad',view:'evidence',limit:2};
const operations=['recall','propose','commit','manage','forget','feedback'];
const count=(service,table)=>service.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
const used=page=>page.items.map(({id,revision})=>({memory_id:id,revision}));
const task=(page,overrides={})=>({request_id:randomUUID(),task_id:randomUUID(),page_receipt:page.feedback_receipt,
  used:used(page),outcome:'useful',basis:'agent_report',...overrides});

async function fixture(policy='observe') {
  const fixture=await setupFake({operations,all_projects:true,feedback_policy:policy});
  const {service,project}=fixture;
  for(const label of ['journal','recovery','checkpoint'])
    await publish(service,record(project,{title:`SQLite ${label} signing evidence`,
      content:`SQLite rollback signing evidence from the synthetic ${label} record.`,tags:[]}));
  return fixture;
}

test('feedback requires a live receipt for the same connection and actual returned versions',async()=>{
  const {service:s}=await fixture();
  const other=new MemoryService({...s.config,connection_id:'foreign-writer'},fake);
  const reader=new MemoryService({...s.config,operations:['recall'],connection_id:'read-only'},fake);
  try {
    const canonical=count(s,'events');
    const first=await s.recall(query);
    assert.equal(first.items.length,2);
    assert.ok(first.feedback_receipt);
    const next=await s.recall({cursor:first.next_cursor});
    assert.ok(next.feedback_receipt);
    assert.equal((await s.recall({cursor:first.next_cursor})).feedback_receipt,next.feedback_receipt);
    assert.equal((await reader.recall(query)).feedback_receipt,undefined);
    assert.equal(count(s,'events'),canonical);
    assert.equal(count(s,'learning_events'),0);
    assert.equal(count(s,'projection_jobs'),0);
    await assert.rejects(reader.feedback(task(first)),{code:'OPERATION_DENIED'});
    await assert.rejects(other.feedback(task(first)),{code:'FEEDBACK_RECEIPT_UNAVAILABLE'});
    await assert.rejects(s.feedback(task(first,{page_receipt:randomUUID()})),{code:'FEEDBACK_RECEIPT_UNAVAILABLE'});
    await assert.rejects(s.feedback(task(first,{used:used(next)})),{code:'FEEDBACK_EVIDENCE_NOT_RETURNED'});
    await assert.rejects(s.feedback(task(first,{used:[{...used(first)[0],revision:2}]})),{code:'FEEDBACK_EVIDENCE_NOT_RETURNED'});
    const request=task(first),saved=await s.feedback(request);
    assert.equal(saved.weight_eligible,false);
    assert.deepEqual(await s.feedback(request),saved);
    const state=QueryState.open(s.db,s.config);
    state.db.prepare('UPDATE queries SET expires=0').run();
    await assert.rejects(s.feedback(task(first)),{code:'FEEDBACK_RECEIPT_EXPIRED'});
    assert.deepEqual(await s.feedback(request),saved);
    assert.equal(s.projectFeedback().changed_edges,0);
    assert.equal(count(s,'association_edges'),0);
  } finally {reader.close();other.close();s.close();}
});

test('concurrent feedback and crash replay preserve one task contribution and its bounded projection',async()=>{
  const {service:s,root}=await fixture('trusted_outcomes');
  const config=join(root,'feedback.json'),input=join(root,'input.json');
  try {
    const page=await s.recall(query);
    const request=task(page,{basis:'test_result',evidence_ref:'test://fixture/confirmed'});
    await writeFile(config,JSON.stringify(s.config));
    await writeFile(input,JSON.stringify(request));
    const calls=await Promise.all(Array.from({length:3},()=>cli(process.execPath,['dist/cli/main.js','feedback','--config',config,'--input',input])));
    assert.ok(calls.every(call=>JSON.parse(call.stdout).weight_eligible));
    assert.equal(count(s,'learning_events'),1);
    assert.equal(count(s,'projection_jobs'),1);
    const alternate=await s.recall(query);
    assert.equal((await s.feedback({...request,page_receipt:alternate.feedback_receipt,request_id:randomUUID()})).duplicate,true);
    const event=s.db.prepare('SELECT evidence_digest,delta FROM learning_events').get();
    assert.notEqual(event.evidence_digest,request.evidence_ref);
    assert.equal(event.delta,0.2);
    const crash=`import {readFileSync} from 'node:fs';
      import {MemoryService} from './dist/core/service.js';
      const s=new MemoryService(JSON.parse(readFileSync(process.argv[1])),undefined,point=>{
        if(point==='feedback:projected')process.kill(process.pid,'SIGKILL');
      });s.projectFeedback();`;
    await assert.rejects(cli(process.execPath,['--input-type=module','-e',crash,config]),{signal:'SIGKILL'});
    assert.equal(count(s,'projection_jobs'),1);
    assert.equal(count(s,'association_edges'),0);
    const result=s.projectFeedback();
    assert.equal(result.processed,1);
    assert.equal(result.changed_edges,1);
    assert.equal(s.projectFeedback().processed,0);
    const weight=s.db.prepare('SELECT weight FROM association_edges').get().weight;
    assert.equal(weight,0.2);
    assert.equal(decayWeight(weight,30*86400000),0.1);
    assert.equal(s.projectFeedback(100,true).watermark,result.watermark);
    assert.equal(s.db.prepare('SELECT weight FROM association_edges').get().weight,weight);
    assert.equal((await s.recall({ids:[request.used[0].memory_id]})).items[0].verification.status,'unverified');
    await s.forget({request_id:randomUUID(),memory_id:request.used[0].memory_id,expected_revision:1});
    assert.equal(count(s,'learning_events'),0);
    assert.equal(count(s,'association_edges'),0);
    assert.equal(s.db.prepare("SELECT count(*) n FROM events WHERE operation='feedback'").get().n,0);
    await assert.rejects(s.feedback(request),{code:'FEEDBACK_EVIDENCE_STALE'});
    assert.equal((await s.recall({ids:[request.used[1].memory_id]})).items.length,1);
  } finally {s.close();}
});

test('STDIO registers feedback only for an explicitly permitted configuration',async()=>{
  const {service:s,root}=await fixture();
  try {
    for(const enabled of [false,true]){
      const config=join(root,`feedback-${enabled}.json`);
      await writeFile(config,JSON.stringify({...s.config,operations:enabled?['recall','feedback']:['recall']}));
      const client=new Client({name:'isolated-feedback-test',version:'1'});
      await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/mcp/server.js')],
        env:{SHARED_MEMORY_CONFIG:config},stderr:'pipe'}));
      try {
        const tools=(await client.listTools()).tools;
        assert.equal(tools.some(tool=>tool.name==='memory_feedback'),enabled);
        if(enabled){
          const response=await client.callTool({name:'memory_feedback',arguments:task({items:[],feedback_receipt:randomUUID()},
            {used:[{memory_id:randomUUID(),revision:1}]})});
          assert.equal(response.isError,true);
          assert.equal(JSON.parse(response.content[0].text).error.code,'FEEDBACK_RECEIPT_UNAVAILABLE');
        }
      } finally {await client.close();}
    }
  } finally {s.close();}
});
