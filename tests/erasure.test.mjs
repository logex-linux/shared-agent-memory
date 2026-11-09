import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { backup } from 'node:sqlite';
import { MemoryService } from '../dist/core/service.js';
import { hash } from '../dist/core/contracts.js';
import { setupFake,fake } from './adaptive-helpers.mjs';
import { publish,record } from './helpers.mjs';

const ref=result=>({memory_id:result.memory_id,revision:result.revision});
const id=randomUUID;
const query={query:'synthetic rollback observation',mode:'broad',limit:1};

test('forget removes historical derivations and exact reimports and revokes old import and source identities',async()=>{
  const {service:s,project,root}=await setupFake();
  const scope=record(project,{title:'Synthetic rollback observation'});
  const digest=hash('synthetic source bytes');
  const original={...scope,content:'Synthetic rollback observation from retained source.',import_key:'old-import',
    sources:[{...scope.sources[0],source_hash:digest}]};
  const updated={...scope,content:'Synthetic rollback observation, second revision.',import_key:'new-import'};
  let restored;
  try {
    const root1=await publish(s,original);
    const child=await publish(s,{...scope,content:'Synthetic rollback observation summary.',derived_from:[ref(root1)]});
    const child2=await publish(s,{...scope,content:'Synthetic rollback observation, edited summary.'},
      {target_id:child.memory_id,expected_revision:1});
    const grandchild=await publish(s,{...scope,content:'Synthetic rollback observation descendant.',derived_from:[ref(child2)]});
    const independent=await publish(s,{...scope,content:'Synthetic rollback observation, independent manual.'},
      {expected_refs:[ref(child2)],relations:[{target_id:child2.memory_id,type:'related_to',sources:scope.sources}]});
    const root2=await publish(s,updated,{target_id:root1.memory_id,expected_revision:1});
    const exactCopy=await publish(s,original);
    const pending=await s.propose({request_id:id(),record:{...original,import_key:'pending',content:'Pending synthetic rephrasing.'}});
    const {path}=await s.export(project,false,'versioned');
    const archive=JSON.parse(await readFile(path,'utf8'));
    const dir=join(root,'restore');await mkdir(dir);
    const database=join(dir,'isolated.db');await backup(s.db,database);
    const cursor=(await s.recall(query)).next_cursor;
    assert.ok(cursor);
    assert.equal(s.check().missing_version_dependencies.n,0);
    const request={request_id:id(),memory_id:root2.memory_id,expected_revision:2};
    const forgotten=await s.forget(request);
    assert.equal(forgotten.derived_erased,3);
    assert.equal((await s.forget(request)).generation,forgotten.generation);
    await assert.rejects(s.recall({cursor}),{code:'CURSOR_STALE'});
    await assert.rejects(readFile(path),{code:'ENOENT'});
    const erased=[root1,child,grandchild,exactCopy];
    assert.deepEqual((await s.recall({ids:erased.map(r=>r.memory_id)})).items,[]);
    assert.deepEqual((await s.recall({versions:[...erased.map(ref),ref(root2),ref(child2)]})).items,[]);
    assert.deepEqual((await s.recall({...query,limit:10})).items.map(r=>r.id),[independent.memory_id]);
    for(const table of ['version_dependencies','dependencies','memory_relations'])
      assert.equal(s.db.prepare('SELECT count(*) n FROM '+table).get().n,0);
    assert.equal(s.db.prepare('SELECT body FROM proposals WHERE id=?').get(pending.proposal_id).body,null);
    const ledger=(await readFile(join(root,'revocations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    const tombstone=ledger.find(t=>t.id===root1.memory_id);
    assert.deepEqual(tombstone.import_keys,['new-import','old-import']);
    assert.deepEqual(tombstone.source_hashes,[digest]);
    assert.equal(tombstone.version_hashes.length,2);
    restored=new MemoryService({...s.config,database},fake);
    await restored.applyRevocations(ledger);
    assert.deepEqual((await restored.recall({versions:erased.map(ref)})).items,[]);
    assert.deepEqual((await restored.recall({...query,limit:10})).items.map(r=>r.id),[independent.memory_id]);
    const replay={...scope,content:'Synthetic material under a different body and ID.'};
    for(const overrides of [{import_key:'old-import'},{sources:original.sources},
      {sources:[{...scope.sources[0],source_hash:tombstone.version_hashes[0]}]}]) {
      const entry={...replay,...overrides};
      assert.equal(restored.previewImport({id:id(),revision:1,record:entry}).action,'blocked_revoked');
      await assert.rejects(restored.propose({request_id:id(),record:entry}),{code:'REVOKED_IMPORT'});
    }
    const renamed=structuredClone(archive);
    renamed.records=[renamed.records.find(r=>r.id===root1.memory_id)];
    renamed.records[0].id=id();
    await assert.rejects(restored.restoreArchive(renamed),{code:'ARCHIVE_BLOCKED_REVOKED'});
  } finally {restored?.close();s.close();}
});
