import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdir,rm,writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setup,record,publish } from './helpers.mjs';
import { MemoryService } from '../dist/core/service.js';
test('weak lexical candidates remain visible as insufficient evidence, not certified facts',async()=>{
  const {service:s,project}=await setup();
  try{
    const m=await publish(s,record(project));
    const r=await s.recall({project_id:project,query:'签名 火星 饼干 传送门'},'lexical');
    assert.equal(r.items[0].id,m.memory_id);assert.equal(r.items[0].evidence_strength,'weak');
    assert.equal(r.evidence_status,'insufficient');assert.ok(r.items[0].recall_reason.includes('lexical_weak'));
  }finally{s.close();}
});
test('export/import preserves ID/revision; repeat import is idempotent; revocation prevents old export resurrection',async()=>{
  const first=await setup(),second=await setup();
  try{
    const a=first.service,b=second.service;
    const r=record(first.project,{import_key:'import-fixture:one'});
    const initial=await publish(a,r);const updated=await publish(a,{...r,content:'新版内容。'},{target_id:initial.memory_id,expected_revision:1});
    const e=await a.export(first.project);const data=JSON.parse(await readFile(e.path,'utf8'));
    b.config.allowed_projects.push(first.project);await b.project(first.project,'imported',first.root);
    await b.applyRevocations([]);
    const imported=await b.importEntry(data.memories[0]);assert.equal(imported.memory_id,initial.memory_id);assert.equal(imported.revision,2);
    assert.equal((await b.importEntry(data.memories[0])).unchanged,true);
    assert.equal(b.db.prepare('SELECT count(*) n FROM memories').get().n,1);
    const importedExport=await b.export(first.project);
    await a.forget({request_id:randomUUID(),memory_id:initial.memory_id,expected_revision:2});
    const revocations=(await readFile(first.root+'/revocations.jsonl','utf8')).trim().split('\n').map(JSON.parse);
    await b.applyRevocations(revocations);
    await b.maintenance();
    await assert.rejects(readFile(importedExport.path),{code:'ENOENT'});
    assert.equal((await b.recall({project_id:first.project,ids:[initial.memory_id]})).items.length,0);
    assert.equal(b.previewImport(data.memories[0]).action,'blocked_revoked');
    await assert.rejects(b.importEntry(data.memories[0]),{code:'IMPORT_BLOCKED_REVOKED'});
  }finally{first.service.close();second.service.close();}
});
test('missing vectors and stale chunk revisions degrade explicitly until a verified rebuild',async()=>{
  const {service:s,project}=await setup();
  try {
    const m=await publish(s,record(project));
    s.db.exec('DELETE FROM memory_vec');
    const missing=await s.recall({project_id:project,query:'-67050'});
    assert.equal(missing.retrieval_mode,'lexical_degraded');assert.ok(missing.warnings.includes('INDEX_INCOMPLETE'));assert.equal(missing.items[0].id,m.memory_id);
    await s.reindex();assert.equal((await s.recall({project_id:project,query:'-67050'})).retrieval_mode,'hybrid');
    s.db.exec('UPDATE memory_chunks SET revision=revision+1');
    assert.equal((await s.recall({project_id:project,query:'-67050'})).retrieval_mode,'lexical_degraded');
    await s.reindex();assert.equal(s.check().orphan_chunks.n,0);
  }finally{s.close();}
});
test('maintenance reports export cleanup and revocation synchronization failures truthfully',async()=>{
  const {service:s,root,project}=await setup();
  try{
    const m=await publish(s,record(project));const e=await s.export(project);
    await rm(e.path);await mkdir(e.path);await mkdir(root+'/revocations.jsonl.tmp');
    const result=await s.forget({request_id:randomUUID(),memory_id:m.memory_id,expected_revision:1});
    assert.equal(result.maintenance.managed_exports_pending,1);assert.equal(result.maintenance.revocations_synced,false);
    assert.equal(s.db.prepare("SELECT value FROM meta WHERE key='revocations_pending'").get().value,1);
    await rm(e.path,{recursive:true});await rm(root+'/revocations.jsonl.tmp',{recursive:true});
    const recovered=await s.maintenance();assert.equal(recovered.managed_exports_pending,0);assert.equal(recovered.revocations_synced,true);
  }finally{s.close();}
});
test('worktree alias resolves same UUID; guessed revocation cannot erase another project',async()=>{
  const {service:s,root,project,other,config}=await setup();
  try{
    await mkdir(root+'/worktree');await s.project(project,'main',root+'/worktree');
    assert.equal((await s.resolveProject(root+'/worktree')).project_id,project);
    const m=await publish(s,record(other));
    const restricted=new MemoryService({...config,allowed_projects:[project]});
    try{
      await assert.rejects(restricted.applyRevocations([{id:m.memory_id,project_id:project,scope:'project',revision:1,content_hash:'a'.repeat(64)}]),{code:'SCOPE_DENIED'});
      await assert.rejects(restricted.importEntry({record:record(other)}),{code:'SCOPE_DENIED'});
    }finally{restricted.close();}
    assert.equal((await s.recall({project_id:other,ids:[m.memory_id]})).items.length,1);
  }finally{s.close();}
});
test('updating from ID recall preserves omitted optional provenance and request retry identity',async()=>{
  const {service:s,project}=await setup();
  try{
    const parent=await publish(s,record(project));
    const m=await publish(s,record(project,{import_key:'keep-metadata',tags:['retain-me'],valid_for:{branch:'main'},derived_from:[{memory_id:parent.memory_id,revision:1}]}));
    const full=(await s.recall({project_id:project,ids:[m.memory_id]})).items[0];assert.equal(full.kind,'procedure');assert.equal(full.import_key,'keep-metadata');assert.deepEqual(full.tags,['retain-me']);
    const r=record(project,{content:'只更新正文。'});delete r.tags;delete r.valid_for;delete r.derived_from;
    const request={request_id:randomUUID(),target_id:m.memory_id,expected_revision:1,record:r};
    const p=await s.propose(request);await s.commit({request_id:randomUUID(),proposal_id:p.proposal_id,expected_revision:1});assert.deepEqual(await s.propose(request),p);
    const after=(await s.recall({project_id:project,ids:[m.memory_id]})).items[0];assert.equal(after.import_key,'keep-metadata');assert.deepEqual(after.tags,['retain-me']);assert.deepEqual(after.derived_from,[{memory_id:parent.memory_id,revision:1}]);assert.equal(after.valid_for.branch,'main');
  }finally{s.close();}
});
