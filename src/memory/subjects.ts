import type {DatabaseSync} from 'node:sqlite';
import {MemoryError,type Ownership,type MemoryRecord} from '../core/contracts.js';
import type {Classification} from '../core/frontier-contracts.js';

export const HISTORICAL_SUBJECT = "json_extract(coalesce(nullif(v.body,''),v.pruned_context),'$.subject_id')";
export const HISTORICAL_CONTEXT = "json_extract(coalesce(nullif(v.body,''),v.pruned_context),'$.context_key')";

export function migrateSubjectCatalog(db:DatabaseSync) {
  db.exec(`
    CREATE TABLE claim_projection(
      memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,content_hash TEXT NOT NULL,
      subject_id TEXT NOT NULL,context_key TEXT NOT NULL,aliases TEXT NOT NULL,
      start INTEGER NOT NULL,end INTEGER NOT NULL,
      CHECK(start>=0 AND end>start AND end<=4000),CHECK(json_valid(aliases))
    );
    CREATE INDEX claim_projection_subject ON claim_projection(subject_id,context_key);
    CREATE INDEX history_subject ON memory_versions(${HISTORICAL_SUBJECT.replaceAll('v.','')},
      ${HISTORICAL_CONTEXT.replaceAll('v.','')}) WHERE body_state<>'head';
    CREATE TRIGGER claim_projection_invalidate AFTER UPDATE ON memories
      WHEN new.revision<>old.revision OR new.content_hash<>old.content_hash OR new.status<>old.status
        OR new.scope<>old.scope OR new.project_id IS NOT old.project_id
      BEGIN DELETE FROM claim_projection WHERE memory_id=new.id; END;
    CREATE VIEW subject_claims AS
      SELECT s.memory_id,s.revision,s.scope,s.project_id,s.kind,s.lifecycle,s.decision_state,s.environment,
        coalesce(s.subject_id,p.subject_id) subject_id,coalesce(s.context_key,p.context_key) context_key,
        coalesce(p.aliases,'[]') aliases,p.start,p.end
      FROM memory_search s LEFT JOIN claim_projection p ON p.memory_id=s.memory_id AND p.revision=s.revision
      WHERE s.status='active';
  `);
}

export function resolveSubject(db:DatabaseSync,owner:Ownership,subject_id:string,context_key:string) {
  const exact=db.prepare(`SELECT 1 FROM subject_claims WHERE scope=? AND project_id IS ?
    AND subject_id=? AND context_key=? AND lifecycle='current' LIMIT 1`).get(owner.scope,owner.project_id,subject_id,context_key);
  if(exact)return {subject_id,context_key,match:'exact' as const};
  const aliases=db.prepare(`SELECT DISTINCT i.subject_id FROM subject_claims i,json_each(i.aliases) a
    WHERE i.scope=? AND i.project_id IS ? AND i.context_key=? AND i.lifecycle='current'
    AND a.value=? LIMIT 2`).all(owner.scope,owner.project_id,context_key,subject_id);
  if(aliases.length>1)throw new MemoryError('SUBJECT_ALIAS_AMBIGUOUS');
  return aliases.length?{subject_id:String(aliases[0].subject_id),context_key,match:'alias' as const}
    :{subject_id,context_key,match:'unregistered' as const};
}

export type AnchoredClaim = Classification & Ownership & {content_hash:string;kind:MemoryRecord['kind'];decision_state?:MemoryRecord['decision_state'];environment?:string};

export function validateSubjectAliases(db:DatabaseSync,changes:AnchoredClaim[],removed:string[]) {
  const names=new Map<string,string>();
  const occupied=db.prepare(`SELECT i.subject_id,i.aliases FROM subject_claims i
    WHERE i.scope=? AND i.project_id IS ? AND i.context_key=? AND i.lifecycle='current'
      AND i.memory_id NOT IN (SELECT value FROM json_each(?))`);
  const active=new Set<string>();
  const replacing=JSON.stringify(removed);
  for(const r of changes) {
    const group=JSON.stringify([r.scope,r.project_id,r.context_key]);
    const register=(subject:string,alias:string)=>{
      const key=JSON.stringify([group,alias]);
      const previous=names.get(key);
      if(previous&&previous!==subject)throw new MemoryError('SUBJECT_ALIAS_CONFLICT');
      names.set(key,subject);
    };
    if(!active.has(group)) {
      for(const row of occupied.iterate(r.scope,r.project_id,r.context_key,replacing)){
        const subject=String(row.subject_id);
        if(row.subject_id!==null)for(const alias of [subject,...JSON.parse(String(row.aliases))])register(subject,alias);
      }
      active.add(group);
    }
    for(const alias of [r.subject_id,...r.aliases])register(r.subject_id,alias);
    if((r.kind==='preference'||r.kind==='decision')&&r.decision_state==='adopted') {
      if(db.prepare(`SELECT 1 FROM subject_claims WHERE scope=? AND project_id IS ? AND context_key=? AND subject_id=?
        AND lifecycle='current' AND decision_state='adopted' AND kind IN ('preference','decision') AND environment IS ?
        AND memory_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1`)
        .get(r.scope,r.project_id,r.context_key,r.subject_id,r.environment??null,replacing))
        throw new MemoryError('CURRENT_RULE_CONFLICT');
      if(changes.some(other=>other!==r&&other.scope===r.scope&&other.project_id===r.project_id&&
        other.context_key===r.context_key&&other.subject_id===r.subject_id&&other.environment===r.environment&&
        ['preference','decision'].includes(other.kind)&&other.decision_state==='adopted'))throw new MemoryError('CURRENT_RULE_CONFLICT');
    }
  }
}
