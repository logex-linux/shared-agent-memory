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

test('rc2 propose and admissionPreview suggest update_revision vs supersede cleanly and exclude target_id', async () => {
  const {service:s,project} = await setup(); s.encoder = encoder;
  try {
    const prev = await publish(s, record(project, {title:'作业材料打包位置约定', content:'2026-11-10 打包汇总，原文件保留原位未删除。'}));
    const structured = await publish(s, record(project, {title:'温度保存规则', subject_id:'storage.retention', context_key:'north', content:'北仓保留 30 天。'}));
    const unrelated = await publish(s, record(project, {title:'完全不相关的气象脚本备忘', content:'2026-11-10 每日气象雷达图像归档路径记录。'}));
    const nextLegacy = record(project, {title:'作业材料打包位置约定', content:'2026-11-10 按用户要求删除原文件，本条更新此前同主题记录：原文件已不再保留。'});
    const previewLegacy = await s.admissionPreview({intent:'reusable', suggestions: true, candidate:{record:nextLegacy}});
    const previewLegacyMatch = previewLegacy.suggestions?.find(c => c.memory_id === prev.memory_id);
    assert.equal(previewLegacyMatch?.suggested_action, 'update_revision');
    assert.equal(previewLegacyMatch?.suggested_transition, undefined);
    const proposalLegacy = await s.propose({request_id: randomUUID(), record: nextLegacy});
    const matchLegacy = proposalLegacy.similar_candidates.find(c => c.memory_id === prev.memory_id);
    assert.ok(matchLegacy, 'should find previous record in similar_candidates');
    assert.equal(matchLegacy.suggested_action, 'update_revision');
    assert.equal(matchLegacy.suggested_transition, undefined);

    const sameTitleNoUpdate = record(project, {title:'温度保存规则', subject_id:'storage.retention', context_key:'north', content:'北仓补充记录：核查温度传感器校准时间。'});
    const plainProp = await s.propose({request_id: randomUUID(), record: sameTitleNoUpdate});
    const plainMatch = plainProp.similar_candidates.find(c => c.memory_id === structured.memory_id);
    assert.equal(plainMatch?.suggested_action, 'update_revision');
    assert.equal(plainMatch?.suggested_transition, undefined);

    const nextStructured = record(project, {title:'温度保存规则', subject_id:'storage.retention', context_key:'north', content:'本条更新此前记录：北仓改为保留 45 天。'});
    const previewStruct = await s.admissionPreview({intent:'reusable', suggestions: true, candidate:{record:nextStructured}});
    const previewStructMatch = previewStruct.suggestions?.find(c => c.memory_id === structured.memory_id);
    assert.equal(previewStructMatch?.suggested_action, 'supersede');
    assert.equal(previewStructMatch?.suggested_transition, 'supersede');
    const proposalStruct = await s.propose({request_id: randomUUID(), record: nextStructured});
    const structMatch = proposalStruct.similar_candidates.find(c => c.memory_id === structured.memory_id);
    assert.equal(structMatch?.suggested_action, 'supersede');
    assert.equal(structMatch?.suggested_transition, 'supersede');

    const updatePreview = await s.admissionPreview({intent:'reusable', suggestions:true, candidate:{target_id:structured.memory_id, expected_revision:1, record:nextStructured}});
    assert.ok(!updatePreview.suggestions?.some(c => c.memory_id === structured.memory_id), 'suggestions must exclude target_id');
    const updateProp = await s.propose({request_id:randomUUID(), target_id:structured.memory_id, expected_revision:1, record:nextStructured});
    assert.ok(!updateProp.similar_candidates.some(c => c.memory_id === structured.memory_id), 'similar_candidates must exclude target_id');

    const noiseProposal = await s.propose({
      request_id: randomUUID(),
      record: record(project, {title:'独立视频转码参数', content:'本条更新此前关于转码参数设定的个人笔记，只涉及音频比特率。'})
    });
    const unrelatedMatch = noiseProposal.similar_candidates.find(c => c.memory_id === unrelated.memory_id);
    assert.equal(unrelatedMatch?.suggested_action, undefined);
    assert.equal(unrelatedMatch?.suggested_transition, undefined);
  } finally { s.close(); }
});

test('rc2 tight budget breaks after first truncated item without duplicate warnings or popped warning leaks', async () => {
  const {service:s,project} = await setup(); s.encoder = encoder;
  try {
    await publish(s, record(project, {
      title:'OmniFetch 架构说明',
      content:'OmniFetch 架构设计说明：'.padEnd(260, 'A')
    }));
    await publish(s, record(project, {title:'无关背景记录', content:'OmniFetch 早期背景补充内容，不包含其他工具名。'}));
    const page = await s.recall({query:'OmniFetch AlphaTool BetaTool 架构设计说明', mode:'focused', view:'evidence', limit:5, token_budget:550});
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].truncated, true);
    assert.equal(page.warnings.filter(w => w === 'RESPONSE_BUDGET').length, 1);
    assert.ok(!page.warnings.includes('EFFECTIVE_TIME_UNKNOWN'));

    // Item 1 fits with known valid_time and full entities; item 2 exceeds budget and is popped -> no warning leaks
    const cleanSetup = await setup(); cleanSetup.service.encoder = encoder;
    try {
      const validWindow = {valid_from:'2020-01-01T00:00:00Z', valid_to:'2099-01-01T00:00:00Z'};
      await publish(cleanSetup.service, record(cleanSetup.project, {
        title:'AlphaTool BetaTool 主文档',
        content:'AlphaTool 与 BetaTool 核心流程与架构设计说明完整记录。',
        valid_time: validWindow
      }));
      await publish(cleanSetup.service, record(cleanSetup.project, {
        title:'AlphaTool 早期碎片',
        content:'AlphaTool 早期背景说明。'
      }));
      const single = await cleanSetup.service.recall({query:'AlphaTool BetaTool 架构设计', mode:'focused', view:'evidence', limit:5, as_of:new Date().toISOString()});
      const oneItemBytes = Buffer.byteLength(JSON.stringify({...single, items: single.items.slice(0, 1)}));
      const popPage = await cleanSetup.service.recall({
        query:'AlphaTool BetaTool 架构设计', mode:'focused', view:'evidence', limit:5,
        as_of:new Date().toISOString(), max_bytes: Math.max(2048, oneItemBytes + 120)
      });
      assert.equal(popPage.items.length, 1);
      assert.equal(popPage.warnings.filter(w => w === 'RESPONSE_BUDGET').length, 1);
      assert.ok(!popPage.warnings.includes('REFERENCE_EVIDENCE_MISSING'));
      assert.ok(!popPage.warnings.includes('EFFECTIVE_TIME_UNKNOWN'));
    } finally { cleanSetup.service.close(); }

    const hugeUri = 'test://blocked/' + 'y'.repeat(1500);
    const blockedOnly = await setup(); blockedOnly.service.encoder = encoder;
    try {
      await publish(blockedOnly.service, record(blockedOnly.project, {
        title:'BlockedItem 架构',
        content:'BlockedItem 说明。',
        sources:[{source_type:'test', uri:hugeUri, locator:'blocked', revision_ref:'v1', checked_at:'2026-11-22T00:00:00Z'}]
      }));
      const blocked = await blockedOnly.service.recall({query:'BlockedItem AlphaTool BetaTool 架构', mode:'focused', view:'evidence', limit:5, token_budget:512, max_bytes:2048, as_of:new Date().toISOString()});
      assert.equal(blocked.empty_reason, 'item_exceeds_budget');
      assert.equal(blocked.warnings.filter(w => w === 'RESPONSE_BUDGET').length, 1);
      assert.ok(!blocked.warnings.includes('REFERENCE_EVIDENCE_MISSING'));
      assert.ok(!blocked.warnings.includes('EFFECTIVE_TIME_UNKNOWN'));
    } finally { blockedOnly.service.close(); }
  } finally { s.close(); }
});

test('rc2 tight budget dropping page_support keeps evidence_status insufficient', async () => {
  const {service:s,project} = await setup(); s.encoder = encoder;
  try {
    await publish(s, record(project, {title:'GatewayA 故障分析', content:'GatewayA 在 Linux 服务器启动异常，记录服务启动故障原因。'}));
    await publish(s, record(project, {title:'GatewayB 一键修复', content:'GatewayB 的修复脚本完成发布并用于线上启动修复。'}));
    const full = await s.recall({query:'GatewayA GatewayB 服务启动故障与线上修复', mode:'focused', view:'evidence', limit:5});
    assert.equal(full.retrieval.page_support?.level, 'direct');
    const fullBytes = Buffer.byteLength(JSON.stringify(full));
    const tightMaxBytes = Math.max(2048, fullBytes - 40);
    const tight = await s.recall({query:'GatewayA GatewayB 服务启动故障与线上修复', mode:'focused', view:'evidence', limit:5, max_bytes:tightMaxBytes});
    assert.equal(tight.retrieval.page_support, undefined);
    assert.equal(tight.evidence_status, 'insufficient');
  } finally { s.close(); }
});

test('rc2 3-entity complementary records form page_support while single-record match and tags alone do not', async () => {
  const {service:s,project} = await setup(); s.encoder = encoder;
  try {
    const a = await publish(s, record(project, {title:'AlphaService 社交平台', content:'AlphaService 负责社交平台与视频下载接入。'}));
    const b = await publish(s, record(project, {title:'BetaEngine 海外引擎', content:'BetaEngine 负责海外引擎与视频下载，不含其他。'}));
    const c = await publish(s, record(project, {title:'GammaWorker 支持范围', content:'GammaWorker 补充海外引擎与支持范围清单。'}));
    const page = await s.recall({query:'AlphaService BetaEngine GammaWorker 社交平台 视频下载 海外引擎 支持范围', mode:'focused', view:'evidence', limit:5});
    assert.equal(page.evidence_status, 'related_evidence');
    assert.equal(page.retrieval.page_support?.composition, 'multi_record');
    assert.equal(page.retrieval.page_support?.level, 'direct');
    const contributors = page.retrieval.page_support.contributors.map(x => x.id);
    assert.deepEqual(new Set(contributors), new Set([a.memory_id, b.memory_id, c.memory_id]));
    assert.ok(page.items.every(item => item.support?.level === 'partial'));
    assert.ok(page.items.every(item => item.recall_reason.includes('background_only')));

    // Single record covers title+content requirements, plus a second record that adds nothing new -> no fake multi_record
    const single = await publish(s, record(project, {title:'DeltaX 部署流程', content:'DeltaX 通过 CLI 部署并输出运行日志。'}));
    const dup = await publish(s, record(project, {title:'DeltaX 运行日志备忘', content:'DeltaX 常规运行日志巡检说明。'}));
    assert.ok(single.memory_id && dup.memory_id);
    const noFake = await s.recall({query:'DeltaX 部署流程 CLI', mode:'focused', view:'evidence', limit:5});
    assert.equal(noFake.retrieval.page_support, undefined);

    // Un-delivered tags cannot synthesize page_support
    await publish(s, record(project, {title:'EpsilonA 接入', content:'EpsilonA 接入流程说明。', tags:['EpsilonC']}));
    await publish(s, record(project, {title:'EpsilonB 接入', content:'EpsilonB 接入流程说明。', tags:['EpsilonC']}));
    const tagPage = await s.recall({query:'EpsilonA EpsilonB EpsilonC 接入流程', mode:'focused', view:'evidence', limit:5});
    assert.equal(tagPage.retrieval.page_support, undefined);
    assert.equal(tagPage.evidence_status, 'insufficient');
  } finally { s.close(); }
});
