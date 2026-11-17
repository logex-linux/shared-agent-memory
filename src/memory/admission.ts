import type {DatabaseSync} from 'node:sqlite';
import {hash,MemoryError,type MemoryRecord,type ProposeInput} from '../core/contracts.js';
import {authority,QueryState} from '../retrieval/state.js';
import {resolveSubject} from './subjects.js';
import {checkDuplicate,findExactDuplicate} from './writes.js';
import {sourceFamily} from './source-status.js';

export const ADMISSION_POLICY='frontier-admission-v1';
export type AdmissionIntent='reusable'|'progress'|'receipt'|'temporary'|'correct'|'supersede'|'variant'|'derive';
type Version={memory_id:string;revision:number};
type Evidence=Version&{body:string};

export function admissionDigest(candidate:ProposeInput,rawRecord:object) {
  const {request_id,admission_id,...material}=candidate;
  return hash({material,fields:Object.keys(rawRecord).sort()});
}

export function admissionDecision(db:DatabaseSync,input:ProposeInput,record:MemoryRecord,intent:AdmissionIntent,previous?:MemoryRecord) {
  const identity=record.subject_id&&record.context_key?resolveSubject(db,record,record.subject_id,record.context_key):null;
  const related:Evidence[]=identity?db.prepare(`SELECT i.memory_id,i.revision,m.body
    FROM subject_claims i JOIN memories m ON m.id=i.memory_id
    WHERE i.scope=? AND i.project_id IS ? AND i.subject_id=? AND i.context_key=? AND i.lifecycle='current'
    ORDER BY m.verified_at DESC,i.memory_id LIMIT 16`)
    .all(record.scope,record.project_id,identity.subject_id,identity.context_key) as Evidence[]:[];
  const families=new Set(record.sources.map(sourceFamily));
  const knownFamilies=new Set(related.flatMap(r=>(JSON.parse(r.body) as MemoryRecord).sources.map(sourceFamily)));
  if(previous)for(const source of previous.sources)knownFamilies.add(sourceFamily(source));
  const report={identity,related:related.map(({memory_id,revision})=>({memory_id,revision})),
    sources:{candidate_families:families.size,shared_families:[...families].filter(f=>knownFamilies.has(f)).length},
    target:input.target_id&&{memory_id:input.target_id,revision:input.expected_revision!}};
  const decision=(action:string,reason:string,ready=false,extra:object={})=>({...report,action,reason,ready,...extra});
  if(intent==='progress'||intent==='receipt')return decision('skip','one_off_record');
  if(intent==='temporary')return decision('task_override','current_task_only');
  if(!previous){
    const duplicate=findExactDuplicate(db,record);
    if(duplicate)return decision('no_change','same_claim_scope_and_sources',false,{duplicate});
  } else {
    try {checkDuplicate(db,record,previous,input.transition??(input.relations?.length?'relation':undefined));}
    catch(error) {
      if(error instanceof MemoryError&&error.code==='NO_CHANGES')return decision('no_change','unchanged_revision');
      throw error;
    }
  }
  if(identity?.match==='alias')return decision('conflict','use_confirmed_subject');
  if(record.consolidation||intent==='derive')
    return decision('derive',record.consolidation?'versioned_evidence':'exact_spans_required',Boolean(record.consolidation));
  if(input.transition==='supersede'||intent==='supersede')
    return decision('supersede',input.transition==='supersede'?'explicit_rule_change':'transition_and_effective_date_required',input.transition==='supersede');
  if(input.transition==='quarantine'||record.lifecycle==='quarantined'||record.verification.status==='disputed')
    return decision('conflict','unresolved_evidence');
  if(previous||intent==='correct')
    return decision('correct',previous?'explicit_revision_update':'existing_revision_required',Boolean(previous));
  if(input.transition==='branch'||intent==='variant')
    return decision('context_variant',input.transition==='branch'?'explicit_context_relation':'distinct_context_required',
      input.transition==='branch'||Boolean(identity&&related.length===0));
  const matching=related.some(r=>{
    const existing=JSON.parse(r.body) as MemoryRecord;
    if(record.memory_form==='episodic'||record.episode||existing.memory_form==='episodic'||existing.episode) {
      const key=(item:MemoryRecord)=>item.episode?.event_ref??item.episode?.event_time;
      if(!key(record)||key(record)!==key(existing))return false;
    }
    return existing.kind===record.kind && (['branch','commit','environment'] as const)
      .every(key=>!existing.valid_for?.[key]||!record.valid_for[key]||existing.valid_for[key]===record.valid_for[key]);
  });
  return matching?decision('conflict','review_existing_identity')
    :decision('new','independent_claim',true);
}

type Binding={policy:string;digest:string;refs:Version[]};
export function checkAdmission(db:DatabaseSync,state:QueryState,config:Parameters<typeof authority>[0],generation:number,id:string,digest?:string) {
  const lease=state.lease('admission',id,authority(config,db));
  if(!lease)throw new MemoryError('ADMISSION_EXPIRED_OR_UNAVAILABLE');
  const binding=JSON.parse(lease.payload) as Binding;
  if(binding.policy!==ADMISSION_POLICY||lease.generation!==generation)throw new MemoryError('ADMISSION_STALE');
  if(digest!==undefined && binding.digest!==digest)throw new MemoryError('ADMISSION_CANDIDATE_MISMATCH');
  const head=db.prepare("SELECT revision FROM memories WHERE id=? AND status='active'");
  for(const ref of binding.refs)if(head.get(ref.memory_id)?.revision!==ref.revision)throw new MemoryError('ADMISSION_STALE');
  return lease.expires;
}
