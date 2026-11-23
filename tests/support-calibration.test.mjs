import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
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

test('rc1 compact detail reduces envelope bytes without altering content or offsets and rejects cursor detail mismatch', async () => {
  const {service:s,project} = await setup(); s.encoder = encoder;
  try {
    await publish(s, record(project, {title:'紧凑证据测试条目一', content:'紧凑证据第一段：测试详情开关保持正文和偏移一致。', tags:['rc1-compact']}));
    await publish(s, record(project, {title:'紧凑证据测试条目二', content:'紧凑证据第二段：测试分页续传禁止中途切换 detail。', tags:['rc1-compact']}));
    const full = await s.recall({query:'紧凑证据', mode:'broad', view:'evidence', detail:'full', limit:1});
    const compact = await s.recall({query:'紧凑证据', mode:'broad', view:'evidence', detail:'compact', limit:1});
    assert.equal(compact.items.length, 1);
    assert.equal(compact.items[0].id, full.items[0].id);
    assert.equal(compact.items[0].content, full.items[0].content);
    assert.deepEqual(compact.items[0].excerpts, full.items[0].excerpts.map(({start,end}) => ({start,end})));
    assert.equal(compact.items[0].verification.status, full.items[0].verification.status);
    assert.equal(compact.items[0].verification.basis, full.items[0].verification.basis);
    assert.equal(compact.items[0].verification.method, undefined);
    assert.equal(compact.items[0].excerpt, undefined);
    assert.equal(compact.items[0].snippet_selection, undefined);
    assert.equal(compact.items[0].written_by, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(full)));
    await assert.rejects(s.recall({cursor:compact.next_cursor, detail:'full'}), {code:'CURSOR_PAGE_OPTIONS_MISMATCH'});
  } finally { s.close(); }
});

test('rc1 multi-record joint coverage elevates page_support without inflating weak items', async () => {
  const {service:s,project} = await setup(); s.encoder = encoder;
  try {
    const a = await publish(s, record(project, {title:'GatewayA 故障分析', content:'GatewayA 在 Linux 服务器启动异常，记录服务启动故障原因。'}));
    const b = await publish(s, record(project, {title:'GatewayB 一键修复', content:'GatewayB 的修复脚本完成发布并用于线上启动修复。'}));
    const trailing = await publish(s, record(project, {title:'Linux 运维手册摘要', content:'服务器日常巡检流程及磁盘空间检查步骤说明。'}));
    const rawImport = await publish(s, record(project, {title:'Codex · Raw Memories / Thread x', tags:['codex-memory', 'historical-source'], content:'GatewayB 历史聊天日志片段：线上启动修复备注。'}));
    const page = await s.recall({query:'GatewayA GatewayB 服务启动故障与线上修复', mode:'focused', view:'evidence', limit:5, debug:true});
    assert.equal(page.evidence_status, 'related_evidence');
    assert.equal(page.retrieval.page_support?.composition, 'multi_record');
    assert.equal(page.retrieval.page_support?.level, 'direct');
    const contributors = page.retrieval.page_support.contributors.map(c => c.id);
    assert.ok(contributors.includes(a.memory_id) && contributors.includes(b.memory_id));
    assert.ok(!contributors.includes(trailing.memory_id), 'trailing non-contributing item should not be listed');
    assert.ok(!contributors.includes(rawImport.memory_id), 'raw codex-memory import should not be synthesized into page_support');
    for (const item of page.items) {
      assert.equal(item.evidence_strength, 'weak');
      assert.equal(item.support?.level, 'partial');
    }
    const compactPage = await s.recall({query:'GatewayA GatewayB 服务启动故障与线上修复', mode:'focused', view:'evidence', detail:'compact', limit:5, debug:true});
    assert.equal(compactPage.evidence_status, 'related_evidence');
    assert.equal(compactPage.retrieval.page_support?.composition, 'multi_record');
    assert.deepEqual(compactPage.retrieval.page_support.contributors, page.retrieval.page_support.contributors);
  } finally { s.close(); }
});

test('rc1 version-line matching keeps minor line visible without fake direct and preserves multi-record visibility', async () => {
  const {service:s,project} = await setup(); s.encoder = encoder;
  try {
    const bg = await publish(s, record(project, {title:'chrome-use MCP 旧版桥接教训', content:'chrome-use 早期 bridge 端口占用排错记录。'}));
    const v02 = await publish(s, record(project, {title:'chrome-use v0.2：click target+expect 核验', content:'chrome-use v0.2 实现单次点击可见状态核验。'}));
    const page = await s.recall({query:'chrome-use 0.2.0 是否支持原生 dialog 超时与单次点击耗时？', mode:'focused', view:'evidence'});
    const hit = page.items.find(item => item.id === v02.memory_id);
    assert.ok(hit, 'v0.2 record should be returned');
    assert.ok(!hit.recall_reason.includes('background_only'), 'version line v0.2 should not be background_only');
    assert.equal(hit.support?.level, 'partial');
    assert.equal(hit.evidence_strength, 'weak');
    assert.ok(page.items.some(item => item.id === bg.memory_id));
  } finally { s.close(); }
});

test('rc1 exact_only zero-hit preflight skips query embedding and vector search', async () => {
  const {service:s,project} = await setup();
  let queryEmbeds = 0;
  s.encoder = {...encoder, query: async () => { queryEmbeds++; return vector(); }};
  try {
    await publish(s, record(project, {title:'已有路径记录', content:'配置文件位于 /etc/existing/app.conf。'}));
    const empty = await s.recall({query:'/Users/missing/nonexistent/settings.json', mode:'focused', view:'evidence', exact_only:true, debug:true});
    assert.equal(empty.items.length, 0);
    assert.equal(empty.evidence_status, 'insufficient');
    assert.equal(queryEmbeds, 0);
    assert.equal(empty.diagnostics.query_embeddings, 0);
    assert.equal(empty.diagnostics.vector_queries, 0);
    assert.equal(empty.diagnostics.ranking_chunk_rows_read, 0);
    const chunksGraph = await s.recall({query:'/Users/missing/nonexistent/settings.json', mode:'focused', view:'chunks', detail:'compact', exact_only:true, graph:true, debug:true});
    assert.ok(chunksGraph.warnings.includes('GRAPH_DISABLED'));
    assert.equal(chunksGraph.retrieval.graph?.reason, 'GRAPH_DISABLED');
    assert.equal(chunksGraph.retrieval.detail, undefined);
    assert.equal(queryEmbeds, 0);
    const present = await s.recall({query:'/etc/existing/app.conf', mode:'focused', view:'evidence', exact_only:true, debug:true});
    assert.equal(present.items.length, 1);
    assert.equal(queryEmbeds, 1);
  } finally { s.close(); }
});

test('rc1 propose marks supersede/correct suggestion for matching title or explicit update wording', async () => {
  const {service:s,project} = await setup(); s.encoder = encoder;
  try {
    const prev = await publish(s, record(project, {title:'作业材料打包位置约定', content:'2026-11-10 打包汇总，原文件保留原位未删除。'}));
    const unrelated = await publish(s, record(project, {title:'完全不相关的气象脚本备忘', content:'2026-11-10 每日气象雷达图像归档路径记录。'}));
    const nextRecord = record(project, {title:'作业材料打包位置约定', content:'2026-11-10 按用户要求删除原文件，本条更新此前同主题记录：原文件已不再保留。'});
    const preview = await s.admissionPreview({intent:'reusable', suggestions: true, candidate:{request_id: randomUUID(), record:nextRecord}});
    const previewMatch = preview.suggestions?.find(c => c.memory_id === prev.memory_id);
    assert.equal(previewMatch?.suggested_transition, 'supersede');
    const proposal = await s.propose({request_id: randomUUID(), record: nextRecord});
    const match = proposal.similar_candidates.find(c => c.memory_id === prev.memory_id);
    assert.ok(match, 'should find previous record in similar_candidates');
    assert.equal(match.suggested_transition, 'supersede');
    const noiseProposal = await s.propose({
      request_id: randomUUID(),
      record: record(project, {title:'独立视频转码参数', content:'本条更新此前关于转码参数设定的个人笔记，只涉及音频比特率。'})
    });
    const unrelatedMatch = noiseProposal.similar_candidates.find(c => c.memory_id === unrelated.memory_id);
    assert.equal(unrelatedMatch?.suggested_transition, undefined);
  } finally { s.close(); }
});
