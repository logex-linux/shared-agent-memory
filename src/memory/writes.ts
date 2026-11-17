import type {DatabaseSync} from 'node:sqlite';
import {MemoryError, stable, type MemoryRecord} from '../core/contracts.js';
import {CURRENT_RULE} from '../retrieval/indexes.js';

export function checkCurrentRule(db:DatabaseSync,record:MemoryRecord,except:string[],previouslyAdopted?:MemoryRecord) {
  if((record.kind!=='preference'&&record.kind!=='decision') || record.decision_state!=='adopted' ||
    (record.lifecycle??'current')!=='current')return;
  if(!record.subject_id?.trim()||!record.context_key?.trim()) {
    if(previouslyAdopted?.decision_state==='adopted' && previouslyAdopted.kind===record.kind &&
      previouslyAdopted.subject_id===record.subject_id && previouslyAdopted.context_key===record.context_key)return;
    throw new MemoryError('RULE_IDENTITY_REQUIRED');
  }
  if(record.subject_id!==record.subject_id.trim()||record.context_key!==record.context_key.trim())
    throw new MemoryError('RULE_IDENTITY_INVALID');
  if(record.valid_time?.valid_from && Date.parse(record.valid_time.valid_from)>Date.now())
    throw new MemoryError('RULE_NOT_YET_EFFECTIVE');
  if(db.prepare(`SELECT 1 FROM memory_search WHERE ${CURRENT_RULE}
    AND scope=? AND project_id IS ? AND subject_id=? AND context_key=? AND environment IS ?
    AND memory_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1`)
    .get(record.scope,record.project_id,record.subject_id,record.context_key,record.valid_for.environment??null,JSON.stringify(except)))
    throw new MemoryError('CURRENT_RULE_CONFLICT');
}

const normalizedText=(value:string)=>value.normalize('NFC').replace(/\r\n?/g,'\n').trim();
function sourcesOf(record:MemoryRecord) {
  // Rechecking the same source changes the observation time, not its identity.
  return [...new Set(record.sources.map(({checked_at,...source})=>stable(source)))].sort();
}
function duplicateKey(record:MemoryRecord) {
  return stable([normalizedText(record.title),normalizedText(record.content),sourcesOf(record),record.valid_for??{},record.valid_time??null,
    record.subject_id??null,record.context_key??null,record.lifecycle??'current',record.decision_state??'unknown',record.derived_from??[]]);
}
export const sameMemoryMaterial=(a:MemoryRecord,b:MemoryRecord)=>a.kind===b.kind&&duplicateKey(a)===duplicateKey(b);
function unchangedKey(record:MemoryRecord) {
  const {author_client,author_session,sources,verification,title,content,...rest}=record;
  const {reviewer,reviewed_at,...claim}=verification;
  return stable([rest,normalizedText(title),normalizedText(content),sourcesOf(record),Object.assign({status:'unverified',basis:'source_claim'},claim)]);
}

export function checkDuplicate(db:DatabaseSync,record:MemoryRecord,previous?:MemoryRecord,transition?:string) {
  if(previous) {
    if(!transition&&unchangedKey(previous)===unchangedKey(record))throw new MemoryError('NO_CHANGES');
    return;
  }
  const first=record.sources[0];
  const matches=db.prepare(`SELECT m.body FROM memory_search s JOIN memories m ON m.id=s.memory_id
    WHERE s.scope=? AND s.project_id IS ? AND s.status='active' AND s.kind=?
    AND EXISTS(SELECT 1 FROM json_each(s.metadata,'$.sources') src WHERE json_extract(src.value,'$.uri')=?
      AND json_extract(src.value,'$.locator')=? AND json_extract(src.value,'$.revision_ref')=?)`)
    .iterate(record.scope,record.project_id,record.kind,first.uri,first.locator,first.revision_ref);
  const key=duplicateKey(record);
  for(const candidate of matches)if(duplicateKey(JSON.parse(String(candidate.body)))===key)throw new MemoryError('DUPLICATE_RECORD');
}
