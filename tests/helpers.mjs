import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryService } from '../dist/core/service.js';
import { after } from 'node:test';
export const MODEL=resolve('.local/models/bge-small-zh-v1.5');
const removeFixture=path=>rm(path,{recursive:true,force:true,maxRetries:3});
export function restoreSchema11Storage(db) {
  db.exec(`DROP TRIGGER current_rule_insert;
    DROP TRIGGER current_rule_update;
    DROP INDEX search_current_rules;
    DROP INDEX search_subject;
    ALTER TABLE memory_search DROP COLUMN subject_id;
    ALTER TABLE memory_search DROP COLUMN context_key;
    ALTER TABLE memory_search DROP COLUMN kind;
    ALTER TABLE proposals DROP COLUMN work_directory;
    DROP INDEX pending_proposal_expiry;
    ALTER TABLE proposals DROP COLUMN expires_at;
    DROP TABLE retired_memories;
    DROP TABLE maintenance_actions;
    DELETE FROM meta WHERE key IN ('maintenance_pending','recovery_pending');
    UPDATE memory_versions AS v SET body=(SELECT m.body FROM memories m WHERE m.id=v.memory_id AND m.revision=v.revision) WHERE v.body_state='head';
    DROP TRIGGER version_insert;
    DROP TRIGGER version_advance;
    DROP TRIGGER version_dependency_insert;
    DROP VIEW version_body_aliases;
    DROP VIEW memory_version_bodies;
    DROP TABLE version_aliases;
    DROP INDEX record_versions_by_time;
    ALTER TABLE memory_versions DROP COLUMN body_state;
    ALTER TABLE memory_versions DROP COLUMN pruned_context;
    ALTER TABLE version_dependencies DROP COLUMN parent_revision;
    CREATE TRIGGER version_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memory_versions VALUES(new.id,new.revision,new.body,new.content_hash,new.verified_at,new.profile_id,new.written_by);
    END;
    CREATE TRIGGER version_advance AFTER UPDATE OF revision ON memories WHEN new.revision<>old.revision BEGIN
      INSERT INTO memory_versions VALUES(new.id,new.revision,new.body,new.content_hash,new.verified_at,new.profile_id,new.written_by);
    END;
    CREATE TRIGGER version_dependency_insert AFTER INSERT ON memory_versions BEGIN
      INSERT OR IGNORE INTO version_dependencies SELECT json_extract(d.value,'$.memory_id'),new.memory_id,new.revision
      FROM json_each(new.body,'$.derived_from') d;
    END;
    CREATE VIRTUAL TABLE memories_fts USING fts5(memory_id UNINDEXED,terms,tokenize='unicode61');
    INSERT INTO memories_fts SELECT id, json_extract(body,'$.title')||' '||json_extract(body,'$.content') FROM memories WHERE status='active';
    PRAGMA user_version=11;`);
}
export function dropTemporalProjection(db) {
  restoreSchema11Storage(db);
  db.exec('DROP INDEX search_temporal_exceptions');
  for(const column of ['lifecycle','valid_from_jd','valid_to_jd','decision_state'])
    db.exec('ALTER TABLE memory_search DROP COLUMN '+column);
}
export async function setup(options={}) {
  const root=await mkdtemp(join(await realpath(tmpdir()),'shared-memory-test-'));
  let service;
  try {
    const project=randomUUID(),other=randomUUID();
    const config={database:join(root,'memory.db'),model_dir:MODEL,allowed_projects:[project,other],allow_global:true,operations:['recall','propose','commit','forget','manage'],semantic_threshold:0.65,dtype:'fp32',threads:2,...options};
    if(dirname(resolve(config.database))!==root)throw Error('Test database must be inside its temporary fixture');
    service=new MemoryService(config);
    await service.project(project,'project',root);
    await mkdir(join(root,'other'));await service.project(other,'project',join(root,'other'));
    if(!process.env.SAM_TEST_WORKSPACE)after(()=>removeFixture(root));
    return {root,project,other,config,service};
  }catch(error){
    service?.close();
    await removeFixture(root);
    throw error;
  }
}
export function record(project,overrides={}) {
  return {project_id:project,scope:project?'project':'global',kind:'procedure',title:'签名授权排错',content:'应用重新构建后屏幕录制授权失效，稳定代码签名后再重新授予屏幕录制权限。错误码 -67050。',tags:['TCC','codesign'],sources:[{source_type:'test',uri:'test://fixtures/signing',locator:'case 1',revision_ref:'fixture-v1',checked_at:new Date().toISOString()}],verification:{method:'isolated integration test',summary:'Synthetic fixture; not a user preference.'},valid_for:{},author_client:'test',author_session:'integration',derived_from:[],...overrides};
}
export async function publish(service,record,update={}) {
  const p=await service.propose({request_id:randomUUID(),record,...update});
  return service.commit({request_id:randomUUID(),proposal_id:p.proposal_id,expected_revision:p.expected_revision});
}
export function forget(service,input) {
  const {memory_id,expected_revision}=input;
  input.plan_hash??=service.forgetPreview({memory_id,expected_revision}).plan_hash;
  return service.forget(input);
}
