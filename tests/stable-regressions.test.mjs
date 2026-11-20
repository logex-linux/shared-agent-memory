import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setup, record, publish} from './helpers.mjs';

const fixture=JSON.parse(await readFile(new URL('../bench/upgrade-v1/stable-regressions.json',import.meta.url),'utf8'));
const vector=(cos=1)=>{const v=new Float32Array(512);v[0]=cos;v[1]=Math.sqrt(Math.max(0,1-cos*cos));return v;};
const encoder={profile:async()=>({id:'stable-regression',manifest:{synthetic:true}}),query:async()=>vector(),
  chunks:async(_,text)=>[{text,start:0,end:text.length,tokens:text.length,vector:vector()}]};
const levels=page=>page.items.map(item=>item.support?.level);

for(const scenario of fixture.cases) test(`stable regression ${scenario.key}: ${scenario.family}`,async()=>{
  const {service:s,project}=await setup();s.encoder=encoder;
  try {
    const wrong=await publish(s,record(project,{title:scenario.distractor.title,content:scenario.distractor.content,tags:['stable-regression']}));
    let page=await s.recall({query:scenario.query,mode:'focused',view:'evidence',limit:5,max_bytes:8000,debug:true});
    assert.equal(page.diagnostics.full_body_records_read,0);
    assert.equal(page.evidence_status,'insufficient');
    const before=page.items.find(item=>item.id===wrong.memory_id);
    assert.ok(before,'wrong object remains visible');
    assert.equal(before.support?.level,'partial');
    assert.equal(before.evidence_strength,'weak');
    assert.ok(before.support.basis.includes('missing_qualifier'));
    assert.ok(before.support.qualifiers_required>=1);

    const gold=await publish(s,record(project,{title:scenario.direct.title,content:scenario.direct.content,tags:['stable-regression']}));
    page=await s.recall({query:scenario.query,mode:'focused',view:'evidence',limit:5,max_bytes:8000,debug:true});
    assert.equal(page.diagnostics.full_body_records_read,0);
    assert.equal(page.evidence_status,'related_evidence');
    assert.equal(page.items[0]?.id,gold.memory_id);
    const direct=page.items.find(item=>item.id===gold.memory_id);
    const near=page.items.find(item=>item.id===wrong.memory_id);
    assert.equal(direct?.support?.level,'direct');
    assert.equal(direct?.evidence_strength,'supported');
    assert.ok(near,'near miss remains visible');
    assert.equal(near.support?.level,'partial');
    assert.equal(near.evidence_strength,'weak');
    assert.deepEqual(page.retrieval.support,{
      direct:levels(page).filter(level=>level==='direct').length,
      partial:levels(page).filter(level=>level==='partial').length,
      missing:levels(page).filter(level=>level==='missing').length
    });
  } finally { s.close(); }
});
