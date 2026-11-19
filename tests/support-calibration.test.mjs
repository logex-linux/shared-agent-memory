import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setup, record, publish} from './helpers.mjs';
import {supportRequirements} from '../dist/retrieval/evidence.js';

const fixture=JSON.parse(await readFile(new URL('../bench/upgrade-v1/support-regressions.json',import.meta.url),'utf8'));
const vector=(cos=1)=>{const v=new Float32Array(512);v[0]=cos;v[1]=Math.sqrt(Math.max(0,1-cos*cos));return v;};
const encoder={profile:async()=>({id:'support-regression',manifest:{synthetic:true}}),query:async()=>vector(),
  chunks:async(_,text)=>[{text,start:0,end:text.length,tokens:text.length,vector:vector()}]};

test('support requirements keep person numbers as clues and slash alternatives together',()=>{
  const course=supportRequirements('2023110042 课程 3391 数字文化 读书笔记 主题 阅读材料');
  assert.ok(!course.entities.some(entity=>entity.anyOf.includes('2023110042')),'person number is a recall clue');
  assert.ok(!course.entities.some(entity=>entity.anyOf.includes('3391')),'course number is a recall clue');
  const vendor=supportRequirements('百炼/Qwen 转写模型与 CLI 的约定');
  assert.ok(vendor.entities.some(entity=>entity.anyOf.includes('百炼')&&entity.anyOf.includes('qwen')),'slash names are alternatives');
  assert.ok(vendor.entities.some(entity=>entity.anyOf.includes('cli')),'CLI remains a required object');
  const link=supportRequirements('Antigravity 与 StepCode 是否共享技能目录 /Users/linnx/.agents/skills');
  assert.deepEqual(link.entities.map(entity=>entity.anyOf),[
    ['/users/linnx/.agents/skills'],['antigravity'],['stepcode']
  ]);
  assert.equal(link.relations[0].label,'share_or_link');
});

test('a partial page with more candidates asks the client to continue',async()=>{
  const {service:s,project}=await setup();s.encoder=encoder;
  try {
    for(const vendor of ['StepAudio','SiliconFlow','XingChen'])
      await publish(s,record(project,{title:`${vendor} 转写流程`,content:`${vendor} 转写模型通过 CLI 批量处理音频，输出字幕文件。`,tags:['transcription']}));
    const page=await s.recall({query:'百炼/Qwen 转写模型与 CLI 的约定',mode:'focused',view:'evidence',limit:1,debug:true});
    assert.equal(page.evidence_status,'insufficient');
    assert.equal(page.has_more,true);
    assert.ok(page.items.every(item=>item.support?.level==='partial'));
    assert.ok(page.warnings.includes('DIRECT_EVIDENCE_MISSING'));
  } finally {s.close();}
});

for(const scenario of fixture.cases) test(`support calibration ${scenario.id}: ${scenario.family}`,async()=>{
  const {service:s,project}=await setup();s.encoder=encoder;
  const published=new Map();
  try {
    for(const stage of scenario.stages) {
      for(const key of stage.publish) if(!published.has(key)) {
        const spec=scenario.records[key];
        assert.ok(spec,`missing record ${key}`);
        const saved=await publish(s,record(project,{title:spec.title,content:spec.content,tags:spec.tags}));
        published.set(key,saved.memory_id);
      }
      const page=await s.recall({query:scenario.query,mode:'focused',view:'evidence',limit:20,debug:true});
      assert.equal(page.diagnostics.full_body_records_read,0);
      assert.equal(page.evidence_status,stage.expect.status);
      assert.deepEqual(page.retrieval.support,{
        direct:page.items.filter(item=>item.support?.level==='direct').length,
        partial:page.items.filter(item=>item.support?.level==='partial').length,
        missing:page.items.filter(item=>item.support?.level==='missing').length
      });
      if(stage.expect.top) assert.equal(page.items[0]?.id,published.get(stage.expect.top));
      for(const [key,level] of Object.entries(stage.expect.levels)) {
        const item=page.items.find(candidate=>candidate.id===published.get(key));
        assert.ok(item,`${key} should remain visible as background`);
        assert.equal(item.support?.level,level,`${key} support level`);
        assert.ok(item.support.basis.length>0,`${key} support basis`);
        assert.equal(item.evidence_strength,level==='direct'?'supported':'weak');
      }
    }
  } finally { s.close(); }
});
