import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import * as vec from 'sqlite-vec';
import { record, publish } from './helpers.mjs';
import { fake, setupFake } from './adaptive-helpers.mjs';
import { MemoryService } from '../dist/core/service.js';
import { hash } from '../dist/core/contracts.js';


function inspectWorker(config) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['tests/process-worker.mjs',config,'inspect','unused']);
    let output='',error='';
    child.stdout.on('data',chunk=>output+=chunk);
    child.stderr.on('data',chunk=>error+=chunk);
    child.once('error',reject);
    child.once('exit',code=>resolve({code,output,error}));
  });
}

test('migration is atomic across interruption and racing opens, preserving Schema 5 data and vector bytes',async()=>{
  const {service:s,root,config,project}=await setupFake();
  const original=await publish(s,record(project));
  await publish(s,record(project,{content:'Revision two is the earliest retained snapshot.'}),{target_id:original.memory_id,expected_revision:1});
  s.db.exec('DROP TRIGGER version_dependency_insert; DROP TABLE version_dependencies; DROP TABLE revoked_aliases; DROP INDEX version_content_hash; DROP TABLE association_edges; DROP TABLE projection_jobs; DROP TABLE learning_events; DELETE FROM meta WHERE key=\'learning_watermark\'; DROP INDEX tombstones_hash; DELETE FROM meta WHERE key=\'graph_epoch\'; DROP TABLE memory_relations; DROP TABLE proposal_transitions; DROP TRIGGER version_insert; DROP TRIGGER version_advance; DROP TABLE memory_versions; DROP TABLE revoked_version_hashes; PRAGMA user_version=5;');
  const signature=db=>['memories','memory_chunks','memory_vec','embedding_profiles','events','memory_search','chunk_fts','chunk_identifiers'].map(table=>
    hash(db.prepare('SELECT * FROM '+table+' ORDER BY 1,2').all()));
  const before=signature(s.db), gen=s.storage.generation(), copy=join(root,'rehearsal.db'), committedCopy=join(root,'post-commit.db');
  await backup(s.db,copy);await backup(s.db,committedCopy);s.close();
  const configPath=join(root,'migration.json');
  await writeFile(configPath,JSON.stringify({...config,database:copy}));
  const killed=spawnSync(process.execPath,['tests/process-worker.mjs',configPath,'crash','migration:before_commit']);
  assert.equal(killed.signal,'SIGKILL',String(killed.stderr));
  const old=new DatabaseSync(copy,{readOnly:true,allowExtension:true});vec.load(old);
  try {
    assert.equal(old.prepare('PRAGMA user_version').get().user_version,5);
    assert.equal(old.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_versions'").get(),undefined);
    assert.deepEqual(signature(old),before);
  } finally {old.close();}
  const committedPath=join(root,'post-commit.json');
  await writeFile(committedPath,JSON.stringify({...config,database:committedCopy}));
  const committed=spawnSync(process.execPath,['tests/process-worker.mjs',committedPath,'crash','migration:after_commit']);
  assert.equal(committed.signal,'SIGKILL',String(committed.stderr));
  const postCommit=new DatabaseSync(committedCopy,{readOnly:true,allowExtension:true});vec.load(postCommit);
  try {
    assert.equal(postCommit.prepare('PRAGMA user_version').get().user_version,10);
    assert.equal(postCommit.prepare('SELECT count(*) n FROM memory_versions').get().n,1);
    assert.deepEqual(signature(postCommit),before);
  } finally {postCommit.close();}
  const runs=await Promise.all(Array.from({length:4},()=>inspectWorker(configPath)));
  for(const run of runs){assert.equal(run.code,0,run.error);assert.equal(JSON.parse(run.output).schema,10);}
  const migrated=new MemoryService({...config,database:copy},fake);
  try {
    assert.deepEqual(signature(migrated.db),before);
    assert.equal(migrated.storage.generation(),gen);
    const missing=await migrated.recall({versions:[{memory_id:original.memory_id,revision:1}]});
    assert.deepEqual(missing.items,[]);
    const current=(await migrated.recall({versions:[{memory_id:original.memory_id,revision:2}]})).items[0];
    assert.equal(current.history_start_revision,2);
    assert.equal(current.history_complete,false);
    assert.equal(current.episode,undefined);
    assert.equal(migrated.check().version_mismatch.n,0);
    assert.equal(migrated.db.prepare('SELECT count(*) n FROM memory_versions').get().n,1);
  } finally {migrated.close();}
});

test('revision expansion keeps historical offsets, scope and paged source budgets',async()=>{
  const {service:s,config,project,other}=await setupFake();
  const oldContent='历史内容 '+ '🎛️'.repeat(580);
  const input=record(project,{content:oldContent,memory_form:'episodic',episode:{event_ref:'synthetic-turn-42',speaker:'operator',event_time:null},
    valid_time:{valid_from:'2026-01-03T00:00:00.000Z',valid_to:null},valid_for:{environment:'dev'}});
  try {
    const m=await publish(s,input);
    const foreign=await publish(s,record(other));
    await publish(s,record(project,{content:'Current production body.',valid_for:{environment:'production'}}),{target_id:m.memory_id,expected_revision:1});
    const first={memory_id:m.memory_id,revision:1}, latest={memory_id:m.memory_id,revision:2};
    const reader=new MemoryService({...config,allowed_projects:[project],allow_global:false,operations:['recall']},fake);
    try {
      const result=await reader.recall({versions:[first,latest,{memory_id:foreign.memory_id,revision:1}],limit:1,max_bytes:2700});
      assert.equal(result.items.length,1);
      assert.deepEqual(result.remaining_versions,[latest]);
      assert.equal(result.has_more,false);
      assert.equal(result.next_cursor,null);
      const old=result.items[0];
      assert.equal(old.revision,1);
      assert.equal(old.current_revision,2);
      assert.equal(old.history_complete,true);
      assert.equal(old.episode.event_time,null);
      assert.equal(old.does_not_imply_current,true);
      assert.equal(old.applicability,'requires_check');
      assert.equal(old.content,oldContent.slice(old.excerpt.start,old.excerpt.end));
      assert.equal(old.truncated,true);
      assert.deepEqual(old.sources,input.sources);
      assert.equal((await reader.recall({versions:result.remaining_versions})).items[0].revision,2);
      assert.deepEqual((await reader.recall({versions:[first],context:{environment:'production'}})).items,[]);
      assert.equal((await reader.recall({ids:[m.memory_id]})).items[0].content,'Current production body.');
      await assert.rejects(reader.recall({ids:[m.memory_id],versions:[first]}));
      const hybrid=await reader.recall({query:'production body',debug:true});
      assert.equal(hybrid.diagnostics.full_body_records_read,0);
    } finally {reader.close();}
  } finally {s.close();}
});

test('versioned restore validates history and revocation blocks old bytes even under a new ID',async()=>{
  const a=await setupFake(),b=await setupFake();
  const s=a.service, dst=b.service, project=a.project;
  try {
    dst.config.allowed_projects.push(project);
    await dst.project(project,'synthetic restore',a.root);
    const initial=await publish(s,record(project,{content:'Old synthetic text'}));
    await publish(s,record(project,{content:'New synthetic text',memory_form:'semantic'}),{target_id:initial.memory_id,expected_revision:1});
    const {path}=await s.export(project,false,'versioned');
    const archive=JSON.parse(await readFile(path,'utf8'));
    assert.equal(archive.format,'shared-agent-memory/versions-v1');
    assert.equal(Object.hasOwn(archive,'memories'),false);
    assert.equal(archive.records[0].versions.length,2);
    assert.equal(dst.previewArchive(archive)[0].action,'create');
    await assert.rejects(dst.restoreArchive(archive),{code:'LATEST_REVOCATIONS_REQUIRED'});
    const corrupt=structuredClone(archive);
    corrupt.records[0].versions[0].body=corrupt.records[0].versions[0].body.replace('Old synthetic','Other synthetic');
    assert.throws(()=>dst.previewArchive(corrupt),{code:'ARCHIVE_HASH_MISMATCH'});
    await dst.applyRevocations([]);
    assert.equal((await dst.restoreArchive(archive)).restored,1);
    assert.equal((await dst.restoreArchive(archive)).unchanged,1);
    const ref={memory_id:initial.memory_id,revision:1};
    assert.equal((await dst.recall({versions:[ref]})).items[0].content,'Old synthetic text');
    assert.equal(dst.check().version_mismatch.n,0);
    assert.equal(dst.check().version_hash_errors.n,0);
    await s.forget({request_id:randomUUID(),memory_id:initial.memory_id,expected_revision:2});
    await assert.rejects(readFile(path),{code:'ENOENT'});
    assert.equal(s.db.prepare('SELECT count(*) n FROM memory_versions').get().n,0);
    const ledger=(await readFile(join(a.root,'revocations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(ledger[0].version_hashes.length,2);
    await dst.applyRevocations(ledger);
    assert.deepEqual((await dst.recall({versions:[ref]})).items,[]);
    const renamed=structuredClone(archive);
    renamed.records[0].id=randomUUID();
    assert.equal(dst.previewArchive(renamed)[0].action,'blocked_revoked');
    await assert.rejects(dst.restoreArchive(renamed),{code:'ARCHIVE_BLOCKED_REVOKED'});
    const old=archive.records[0].versions[0];
    assert.equal(dst.previewImport({id:randomUUID(),revision:1,content_hash:old.content_hash,record:JSON.parse(old.body)}).action,'blocked_revoked');
  } finally {s.close();dst.close();}
});
