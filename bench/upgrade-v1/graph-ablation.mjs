import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MemoryService } from '../../dist/core/service.js';
import { fingerprint, tasks } from './tasks.mjs';

if (!process.argv[2]) throw Error('Pass an existing output directory for a new isolated graph fixture.');
const root = await mkdtemp(join(await realpath(process.argv[2]), 'graph-ablation-'));
const database = join(root, 'memory.db');
const project = '7cb6c80a-1452-4d97-8f59-dfbd102b50da';
const scenarios = tasks.filter(task => task.category === 'cross-event');
const config = { database, model_dir: resolve('.local/models/bge-small-zh-v1.5'),
  allowed_projects: [project], operations: ['recall','manage','propose','commit'], graph_enabled: true };
const service = new MemoryService(config);
const expected = new Map();
const excluded = new Set();

function source(record) {
  return { source_type: 'test', uri: record.source, locator: 'frozen source event',
    revision_ref: fingerprint, checked_at: '2026-06-01T00:00:00.000Z' };
}

async function publish(record, related, type) {
  const proposal = await service.propose({ request_id: randomUUID(), record: {
    project_id: project, scope: 'project', kind: 'fact', title: record.title, content: record.content,
    sources: [source(record)], tags: [], valid_for: record.environment ? {environment:record.environment} : {},
    subject_id:record.subject, context_key:'operational incident',
    author_client: 'evaluation', author_session: 'frozen-graph',
    verification: {method:'synthetic fixture', summary:'Predefined event in the frozen benchmark.'}
  }, ...(related ? {
    expected_refs: [{memory_id:related.memory_id, revision:related.revision}],
    relations: [{target_id:related.memory_id, type, sources:[source(record)]}]
  } : {}) });
  return service.commit({request_id:randomUUID(), proposal_id:proposal.proposal_id, expected_revision:0});
}

const quantile = (values, p) => [...values].sort((a,b) => a-b)[Math.ceil(values.length*p)-1];
const mean = values => values.reduce((a,b) => a+b,0)/values.length;
const runs = [];
try {
  await service.project(project,'Frozen graph evaluation',root);
  for (const task of scenarios) {
    const byKey = Object.fromEntries(task.records.map(record => [record.key, record]));
    // Publish in dependency order so each frozen source keeps revision 1.
    const check = await publish(byKey.check);
    const cause = await publish(byKey.cause, check, 'supports');
    const incident = await publish(byKey.incident, cause, 'related_to');
    const distractor = await publish(byKey.distractor);
    const refs = {check,cause,incident};
    expected.set(task.id, task.expected.evidence.map(({key, revision}) => ({
      id:refs[key].memory_id, revision, source:byKey[key].source
    })));
    excluded.add(distractor.memory_id);
  }
  const request = (task, graph) => ({ query:task.query, ...task.request,
    view:'evidence', mode:'focused', limit:5, graph, debug:true });
  await service.recall(request(scenarios[0], false));
  await service.recall(request(scenarios[0], true));
  for (let round=0; round<3; round++) {
    const samples = [];
    for (const task of scenarios) {
      const pair = { id:task.id, split:task.split };
      for (const arm of round%2 ? ['C','B'] : ['B','C']) {
        const start=performance.now();
        const result=await service.recall(request(task, arm==='C'));
        const ms=performance.now()-start;
        assert.equal(result.retrieval_mode,'hybrid');
        assert.equal(result.diagnostics.full_body_records_read,0);
        assert(!result.items.some(item => excluded.has(item.id)));
        assert(result.items.length<=5);
        const hits=expected.get(task.id).filter(ref => result.items.some(item =>
          item.id===ref.id && item.revision===ref.revision && item.sources.some(s => s.uri===ref.source)));
        pair[arm]={ms, recall: hits.length/expected.get(task.id).length,
          evidence:result.items.map(item => item.sources[0].uri),
          answer_excerpt:result.items.some(item => item.content.includes(task.expected.answer)),
          paths:result.items.filter(item => item.graph_path).length,
          graph_rows:result.diagnostics.graph_rows_examined ?? 0,
          bytes:result.diagnostics.response_bytes, lock_ms:result.diagnostics.state_lock?.held_ms ?? null};
      }
      samples.push(pair);
    }
    const byArm = Object.fromEntries(['B','C'].map(arm => {
      const rows = samples.map(pair => pair[arm]);
      return [arm,{p50_ms:quantile(rows.map(row => row.ms),.5),p95_ms:quantile(rows.map(row => row.ms),.95),
        recall:mean(rows.map(row => row.recall)),paths:rows.reduce((n,row) => n+row.paths,0)}];
    }));
    runs.push({round,byArm,samples});
  }
} finally { service.close(); }

// Independent units are held-out subject families. Repeated timings are not new labels.
const heldOut=runs[0].samples.filter(pair => pair.split==='test');
const deltas=heldOut.map(pair => pair.C.recall-pair.B.recall);
let seed=417713;
const bootstrap=Array.from({length:10000}, () => mean(deltas.map(() => {
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  return deltas[Math.floor(seed/2**32*deltas.length)];
})));
const summary={tasks:scenarios.length,held_out:heldOut.length,
  B:mean(heldOut.map(pair => pair.B.recall)),C:mean(heldOut.map(pair => pair.C.recall)),
  paired_delta:mean(deltas),ci95:[quantile(bootstrap,.025),quantile(bootstrap,.975)],
  improved:deltas.filter(delta => delta>0).length,regressed:deltas.filter(delta => delta<0).length};
const report={fingerprint,summary,runs};
await writeFile(join(root,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({root,summary,runs:runs.map(({round,byArm}) => ({round,byArm}))},null,2));
