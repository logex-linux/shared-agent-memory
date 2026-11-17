import type {DatabaseSync} from 'node:sqlite';
import {hash,MemoryError,type Config} from '../core/contracts.js';

const DAY=86400000;
export const cutoff=(days:number)=>new Date(Date.now()-days*DAY).toISOString();
export const expires=(days:number)=>new Date(Date.now()+days*DAY).toISOString();
type Policy=Config['retention'];

export function migrateProposalExpiry(db:DatabaseSync) {
  db.exec(`
    ALTER TABLE proposals ADD COLUMN expires_at TEXT;
    UPDATE proposals SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+7 days') WHERE status='pending';
    CREATE INDEX pending_proposal_expiry ON proposals(expires_at,id) WHERE status='pending';
    CREATE INDEX record_versions_by_time ON memory_versions(recorded_at,memory_id,revision) WHERE body_state='stored';
  `);
}

export function pinned(db:DatabaseSync,id:string,revision:number|null) {
  const anyRevision=revision===null?1:0;
  return Boolean(db.prepare(`
    SELECT 1 FROM version_dependencies WHERE parent_id=? AND (?=1 OR parent_revision IS NULL OR parent_revision=?)
    UNION ALL SELECT 1 FROM dependencies WHERE parent_id=? AND (?=1 OR parent_revision=?)
    UNION ALL SELECT 1 FROM memory_relations WHERE from_id=? AND (?=1 OR from_revision=?)
    UNION ALL SELECT 1 FROM memory_relations WHERE to_id=? AND (?=1 OR to_revision=?)
    UNION ALL SELECT 1 FROM learning_events WHERE a=? AND (?=1 OR a_revision=?)
    UNION ALL SELECT 1 FROM learning_events WHERE b=? AND (?=1 OR b_revision=?)
    UNION ALL SELECT 1 FROM association_edges WHERE a=? AND (?=1 OR a_revision=?)
    UNION ALL SELECT 1 FROM association_edges WHERE b=? AND (?=1 OR b_revision=?)
    LIMIT 1`).get(...Array.from({length:8},()=>[id,anyRevision,revision]).flat()));
}

export function versionCandidate(db:DatabaseSync,id:string,revision:number,policy:Policy) {
  const row=db.prepare(`SELECT v.body_state,v.content_hash,v.recorded_at,v.revision,
      (SELECT count(*) FROM memory_versions newer WHERE newer.memory_id=v.memory_id AND newer.revision>v.revision) newer
    FROM memory_versions v WHERE v.memory_id=? AND v.revision=?`).get(id,revision);
  if(!row)throw new MemoryError('VERSION_NOT_FOUND');
  const reason=row.body_state!=='stored'?String(row.body_state):
    String(row.recorded_at)>=cutoff(Math.max(policy.recovery_days,policy.history_days))?'recovery_window':
    Number(row.newer)<policy.keep_revisions?'recent_revision':pinned(db,id,revision)?'referenced':null;
  return {memory_id:id,revision,content_hash:String(row.content_hash),recorded_at:String(row.recorded_at),reason};
}

export function pruneBody(db:DatabaseSync,ref:{memory_id:string;revision:number;content_hash:string}) {
  const row=db.prepare('SELECT body_state,content_hash FROM memory_versions WHERE memory_id=? AND revision=?').get(ref.memory_id,ref.revision);
  if(!row || row.content_hash!==ref.content_hash || row.body_state==='head' || pinned(db,ref.memory_id,ref.revision))
    throw new MemoryError('PRUNE_VERSION_CONFLICT');
  if(row.body_state==='pruned')return;
  db.prepare(`UPDATE memory_versions SET pruned_context=json_object(
      'valid_for',json_extract(body,'$.valid_for'),'valid_time',json_extract(body,'$.valid_time'),
      'decision_state',json_extract(body,'$.decision_state'),'subject_id',json_extract(body,'$.subject_id'),
      'context_key',json_extract(body,'$.context_key')),body='',body_state='pruned'
    WHERE memory_id=? AND revision=?`).run(ref.memory_id,ref.revision);
}

export function checkRetiredVersion(db:DatabaseSync,id:string,revision:number,bodyHash:string) {
  const at=db.prepare('SELECT content_hash FROM memory_versions WHERE memory_id=? AND revision=?').get(id,revision);
  if(!at||at.content_hash!==bodyHash)throw new MemoryError('RETIRE_VERSION_CONFLICT');
}

export function retainedSourceKeys(db:DatabaseSync,id:string) {
  const rows=db.prepare(`SELECT s.value FROM memory_version_bodies v,json_each(v.body,'$.sources') s
    WHERE v.memory_id=? AND v.body_state IN ('stored','head')`).all(id);
  return new Set(rows.map(row=>{
    const {checked_at,...source}=JSON.parse(String(row.value));
    return hash(source);
  }));
}
