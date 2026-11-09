import test from 'node:test';
import assert from 'node:assert/strict';
import { record, publish } from './helpers.mjs';
import { setupFake } from './adaptive-helpers.mjs';


test('effective time uses the asserted interval for a late event and respects its exclusive end',async()=>{
  const {service:s,project}=await setupFake();
  const cutoff='2026-03-01T00:00:00.000Z';
  const first='2026-01-01T00:00:00.000Z';
  const title='Fictional search policy';
  try {
    const latest=await publish(s,record(project,{title,content:'The production search policy uses eight shards.',
      subject_id:'router-a',lifecycle:'current',valid_for:{environment:'production'},
      valid_time:{valid_from:cutoff,valid_to:'2090-01-01T00:00:00.000Z'}}));
    const late=await publish(s,record(project,{title,content:'The production search policy used twenty-four shards.',
      subject_id:'router-a',lifecycle:'historical',memory_form:'episodic',episode:{event_time:first},
      valid_time:{valid_from:first,valid_to:cutoff},valid_for:{environment:'production'}}));
    const hidden=await publish(s,record(project,{title,content:'A conflicting draft claims six shards.',
      lifecycle:'quarantined',valid_time:{valid_from:first,valid_to:'2090-01-01T00:00:00.000Z'}}));
    const unknown=await publish(s,record(project,{title,content:'A search policy fragment of unknown date.',episode:{event_time:null}}));
    const ids=[late.memory_id,latest.memory_id,hidden.memory_id];
    assert.deepEqual((await s.recall({ids})).items.map(x=>x.id),[latest.memory_id]);
    const past=await s.recall({ids,as_of:first,context:{environment:'production'}});
    assert.deepEqual(past.items.map(x=>x.id),[late.memory_id]);
    assert.equal(past.items[0].effective_time,'matched');
    assert.ok(past.items[0].record_updated_at>cutoff);
    assert.deepEqual((await s.recall({ids,as_of:cutoff,context:{environment:'production'}})).items.map(x=>x.id),[latest.memory_id]);
    assert.deepEqual((await s.recall({ids,as_of:first,context:{environment:'staging'}})).items,[]);
    const uncertain=await s.recall({ids:[unknown.memory_id],as_of:first});
    assert.equal(uncertain.items[0].effective_time,'unknown');
    assert.equal(uncertain.items[0].applicability,'requires_check');
    assert.equal(uncertain.evidence_status,'insufficient');
    assert.ok(uncertain.warnings.includes('EFFECTIVE_TIME_UNKNOWN'));
    assert.equal((await s.recall({ids:[hidden.memory_id],include_history:true})).items[0].applicability,'requires_check');
    const historical=await s.recall({versions:[{memory_id:late.memory_id,revision:1}],as_of:cutoff});
    assert.deepEqual(historical.items,[]);
  } finally {s.close();}
});

test('explicit proposal state cannot be read as adopted even when draft prose claims implementation',async()=>{
  const {service:s,project}=await setupFake();
  const title='Delta delivery design';
  try {
    const draft=await publish(s,record(project,{title,content:'Draft quotation: “We adopted option Delta.” Approval is still open.',
      decision_state:'proposed'}));
    await publish(s,record(project,{title,content:'The team rejected option Alpha.',decision_state:'rejected'}));
    const query='Which option did the team adopt for Delta delivery design?';
    const strict=await s.recall({query,decision_state:'adopted',mode:'focused'});
    assert.deepEqual(strict.items,[]);
    assert.equal(strict.evidence_status,'insufficient');
    const hinted=await s.recall({query:'Which option was adopted for Delta delivery design?',mode:'focused'});
    assert.equal(hinted.evidence_status,'insufficient');
    const proposal=await s.recall({query,decision_state:'proposed',mode:'focused'});
    assert.equal(proposal.items[0].id,draft.memory_id);
    assert.equal(proposal.items[0].answer_relevance.assessment,'declared_state');
    assert.equal(proposal.items[0].answer_relevance.state,'proposed');
    assert.equal(proposal.items[0].verification.status,'unverified');
  } finally {s.close();}
});

test('continuations cannot change the selected effective time or lifecycle scope',async()=>{
  const {service:s,project}=await setupFake();
  const as_of='2026-01-01T00:00:00.000Z';
  try {
    for(let i=0;i<3;i++)await publish(s,record(project,{title:'Fictional shared search policy '+i,content:'This search policy uses eight shards.',
      valid_time:{valid_from:as_of,valid_to:'2090-01-01T00:00:00.000Z'}}));
    const first=await s.recall({query:'shared search policy',mode:'broad',limit:1,as_of});
    assert.ok(first.next_cursor);
    await assert.rejects(s.recall({cursor:first.next_cursor,as_of:'2026-02-01T00:00:00.000Z'}),{code:'CURSOR_QUERY_MISMATCH'});
    await assert.rejects(s.recall({cursor:first.next_cursor,include_history:true}),{code:'CURSOR_QUERY_MISMATCH'});
    const next=await s.recall({cursor:first.next_cursor});
    assert.equal(next.items[0].effective_time,'matched');
    assert.notEqual(next.items[0].id,first.items[0].id);
  } finally {s.close();}
});
