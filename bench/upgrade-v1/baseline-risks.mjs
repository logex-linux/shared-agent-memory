import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const kernel = resolve(process.argv[2] ?? '.local/upgrade-v1/p0/baseline/dist');
const { MemoryService } = await import(pathToFileURL(join(kernel, 'core/service.js')));
const { factState } = await import(pathToFileURL(join(kernel, 'retrieval/evidence.js')));
const temp = await realpath(tmpdir());
const root = await mkdtemp(join(temp, 'sam-baseline-risks-'));
const database = join(root, 'memory.db');
assert.equal(dirname(root), temp);
assert.equal(dirname(database), root);

const project = randomUUID();
const vector = new Float32Array(512);
vector[0] = 1;
const encoder = {
  profile: async () => ({ id:'baseline-risk-mock', manifest:{} }),
  query: async () => vector,
  chunks: async (_, text) => [{text, start:0, end:text.length, tokens:1, vector}]
};
const config = {database, model_dir:root, allowed_projects:[project], operations:['manage','propose','commit','recall','forget']};
const s = new MemoryService(config, encoder);
const record = (content, overrides = {}) => ({
  scope:'project', project_id:project, kind:'decision', title:'Fictional Quartz worker',
  content, sources:[{source_type:'test', uri:'test://baseline/source', locator:'1', revision_ref:'test', checked_at:'2026-01-01T00:00:00.000Z'}],
  verification:{method:'fixture', summary:'Synthetic source'}, author_client:'fixture', author_session:'baseline', ...overrides
});
async function publish(body, target) {
  const p = await s.propose({request_id:randomUUID(), record:body,
    ...(target ? {target_id:target.memory_id, expected_revision:target.revision} : {})});
  return s.commit({request_id:randomUUID(), proposal_id:p.proposal_id, expected_revision:p.expected_revision});
}
try {
  await s.project(project, 'Fictional Quartz', root);
  const parent = await publish(record('The historical worker limit was eight.', {valid_for:{environment:'development'}}));
  const oldExport = JSON.parse(await readFile((await s.export(project)).path)).memories[0];
  const production = await publish(record('Production uses twenty workers.', {valid_for:{environment:'production'}}));
  const child = await publish(record('Summary of the development limit.', {derived_from:[{memory_id:parent.memory_id, revision:1}]}));
  await publish(record('Development uses ten workers.', {valid_for:{environment:'development'}}), parent);
  const dev = await s.recall({ids:[parent.memory_id, production.memory_id, child.memory_id], context:{environment:'development'}});
  assert.deepEqual(dev.items.map(x=>x.id), [parent.memory_id]);
  assert.equal(dev.items[0].revision, 2);
  assert.equal(s.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='memory_versions'").get().n, 0);
  await assert.rejects(s.recall({versions:[{memory_id:parent.memory_id, revision:1}]}));

  const proposed = 'Draft excerpt of a future release note. “We adopted option Delta.” Approval is still open.';
  assert.equal(factState(proposed, 'source_claim'), 'implemented');
  const eventCount = s.db.prepare('SELECT count(*) n FROM events').get().n;
  for (let i=0;i<2;i++) await s.recall({query:'Quartz development worker limit'});
  assert.equal(s.db.prepare('SELECT count(*) n FROM events').get().n, eventCount);
  assert.equal(typeof s.feedback, 'undefined');

  await s.forget({request_id:randomUUID(), memory_id:parent.memory_id, expected_revision:2});
  assert.equal(s.previewImport(oldExport).action, 'blocked_revoked');
  assert.equal(s.previewImport({...oldExport, id:randomUUID()}).action, 'create');
  console.log(JSON.stringify({
    exact_old_revision:'unavailable', draft_quote_classified:'implemented',
    environment_and_dependency_filter:'pass', recall_business_event_writes:0,
    feedback:'unavailable', old_revision_restore_same_id:'blocked',
    old_revision_restore_new_id:'not blocked in preview'
  }));
} finally {
  s.close();
  await rm(root, {recursive:true, force:true});
}
