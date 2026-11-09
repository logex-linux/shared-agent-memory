import type { DatabaseSync } from 'node:sqlite';
import { MemoryError, type MemoryRecord, type ProposeInput } from '../core/contracts.js';

export type TransitionPlan = Pick<ProposeInput,'transition'|'expected_refs'|'relations'>;

export function migrateRelations(db:DatabaseSync) {
  db.exec(`
    CREATE TABLE proposal_transitions(
      proposal_id TEXT PRIMARY KEY REFERENCES proposals(id) ON DELETE CASCADE,
      plan TEXT NOT NULL
    );
    CREATE TABLE memory_relations(
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
      from_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      from_revision INTEGER NOT NULL,
      to_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      to_revision INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('supports','contradicts','supersedes','context_variant','related_to')),
      project_id TEXT, scope TEXT NOT NULL CHECK(scope IN ('project','global')),
      sources TEXT NOT NULL, recorded_at TEXT NOT NULL,
      CHECK(from_id<>to_id),
      CHECK((scope='global')=(project_id IS NULL)),
      UNIQUE(from_id,from_revision,to_id,to_revision,type)
    );
    CREATE INDEX relation_to ON memory_relations(to_id,to_revision,type);
  `);
}

export function validateTransition(record:MemoryRecord, previous:MemoryRecord, type:TransitionPlan['transition']) {
  if (type!=='reinforce' && type!=='supersede' && type!=='branch') return;
  if (!record.subject_id || record.subject_id!==previous.subject_id)throw new MemoryError('TRANSITION_SUBJECT_MISMATCH');
  if ((previous.lifecycle??'current')!=='current' || (record.lifecycle??'current')!=='current')
    throw new MemoryError('TRANSITION_LIFECYCLE_CONFLICT');
  const contextPairs = [
    [record.context_key,previous.context_key],
    ...(['branch','commit','environment'] as const).map(k=>[record.valid_for[k],previous.valid_for[k]])
  ];
  if(type==='branch') {
    if(!contextPairs.some(([a,b])=>a&&b&&a!==b))throw new MemoryError('TRANSITION_CONTEXT_NOT_DISTINCT');
    return;
  }
  if(!contextPairs.some(([a,b])=>a&&b) || contextPairs.some(([a,b])=>a!==b))
    throw new MemoryError('TRANSITION_CONTEXT_MISMATCH');
  if(type==='reinforce') {
    if(record.decision_state!==previous.decision_state)throw new MemoryError('TRANSITION_DECISION_CONFLICT');
    if(record.sources.some(a=>previous.sources.some(b=>a.uri===b.uri || a.source_hash&&a.source_hash===b.source_hash)))
      throw new MemoryError('TRANSITION_SOURCE_REPEATED');
    return;
  }
  const cutoff=record.valid_time?.valid_from;
  if(!cutoff || Date.parse(cutoff)>Date.now() ||
    previous.valid_time?.valid_from && Date.parse(previous.valid_time.valid_from)>=Date.parse(cutoff))
    throw new MemoryError('TRANSITION_EFFECTIVE_TIME_REQUIRED');
}

export function supersededRecord(previous:MemoryRecord, cutoff:string):MemoryRecord {
  const previousEnd=previous.valid_time?.valid_to;
  const valid_to=previousEnd && Date.parse(previousEnd)<Date.parse(cutoff)?previousEnd:cutoff;
  return {...previous,lifecycle:'historical',valid_time:{...previous.valid_time,valid_to}};
}
