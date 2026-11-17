import type {DatabaseSync} from 'node:sqlite';
import {estimateTokens} from './recall.js';
import {hash,MemoryError,type Config,type MemoryRecord,type RecallInput} from '../core/contracts.js';
import {sourceFamily,sourceStatus} from '../memory/source-status.js';

type Span={start:number;end:number};
type RecallItem={
  id:string;revision:number;content:string;sources:MemoryRecord['sources'];title:string;kind:MemoryRecord['kind'];
  scope:string;project_id:string|null;subject_id?:string;context_key?:string;excerpts:Span[];truncated?:boolean;
  decision_state?:MemoryRecord['decision_state'];lifecycle?:MemoryRecord['lifecycle'];memory_form?:MemoryRecord['memory_form'];
  valid_for?:MemoryRecord['valid_for'];valid_time?:MemoryRecord['valid_time'];verification:MemoryRecord['verification'];
  applicability:string;evidence_strength:string;does_not_imply_current?:boolean;recall_reason:string[];
};
type RecallPage={
  generation:number;items:RecallItem[];retrieval_mode:string;warnings:string[];has_more:boolean;next_cursor:string|null;
  remaining_ids?:string[];remaining_versions?:{memory_id:string;revision:number}[];
  pruned_versions?:{memory_id:string;revision:number}[];
};
const section=(item:RecallItem)=>{
  if(item.verification.status==='disputed'||item.lifecycle==='quarantined')return 'conflict';
  if(item.applicability!=='current'||item.does_not_imply_current)return 'requires_check';
  if(item.kind==='procedure'||item.memory_form==='procedural')return 'procedure';
  if(['preference','decision'].includes(item.kind))return item.decision_state==='adopted'?'current':'evidence';
  return 'evidence';
};

export function packEvidence(db:DatabaseSync,config:Config,input:RecallInput,page:RecallPage) {
  const warnings=new Set(page.warnings),sources:ReturnType<typeof sourceStatus>[]=[],sourceIndex=new Map<string,number>();
  const sourceGroups:string[][]=[];
  const items=[];
  const version=db.prepare('SELECT body,content_hash FROM memory_version_bodies WHERE memory_id=? AND revision=?');
  for(const item of page.items) {
    if(item.recall_reason.includes('background_only')||item.evidence_strength!=='supported')continue;
    const exact=version.get(item.id,item.revision);
    if(!exact?.body)throw new MemoryError('VIEW_STALE');
    const record=JSON.parse(String(exact.body)) as MemoryRecord;
    const spans=item.excerpts.filter(e=>e.end>e.start&&e.start>=0&&e.end<=record.content.length)
      .map(({start,end})=>({start,end,text:record.content.slice(start,end)}));
    if(!spans.length||spans.map(s=>s.text).join('\n…\n')!==item.content) {
      warnings.add('EVIDENCE_SPAN_UNAVAILABLE');
      continue;
    }
    const refs=[];
    for(const source of item.sources){
      const {checked_at,...location}=source,key=hash(location);
      let ref=sourceIndex.get(key);
      if(ref===undefined){
        ref=sources.length;
        const status=sourceStatus(source);
        sources.push(status);sourceIndex.set(key,ref);
        const keys=[sourceFamily(source),source.uri];
        const groups=sourceGroups.filter(group=>keys.some(mark=>group.includes(mark)));
        for(const group of groups)sourceGroups.splice(sourceGroups.indexOf(group),1);
        sourceGroups.push([...new Set([...keys,...groups.flat()])]);
        if(status.state==='missing'||status.state==='unresolved')warnings.add('SOURCE_GAP');
        if(status.state==='unchecked')warnings.add('SOURCE_UNCHECKED');
      }
      refs.push(ref);
    }
    const use=section(item);
    items.push({use,memory_id:item.id,revision:item.revision,content_hash:exact.content_hash,
      title:item.title,kind:item.kind,project_id:item.project_id,scope:item.scope,spans,source_refs:refs,
      conditions:{...item.valid_for,...(item.valid_time&&{effective:item.valid_time})},
      ...(item.subject_id&&{subject_id:item.subject_id}),...(item.context_key&&{context_key:item.context_key}),
      verification:item.verification.status,decision_state:item.decision_state,lifecycle:item.lifecycle,
      ...(item.truncated&&{truncated:true})});
  }
  const selected=JSON.stringify(items.map(i=>[i.memory_id,i.revision]));
  const conflicts=db.prepare(`WITH picked AS (
    SELECT json_extract(value,'$[0]') id,json_extract(value,'$[1]') revision FROM json_each(?)
  ) SELECT e.from_id,e.from_revision,e.to_id,e.to_revision FROM memory_relations e
    JOIN picked a ON a.id=e.from_id AND a.revision=e.from_revision
    JOIN picked b ON b.id=e.to_id AND b.revision=e.to_revision WHERE e.type='contradicts' ORDER BY e.id`).all(selected);
  if(conflicts.length){
    const disputed=new Set(conflicts.flatMap(r=>[r.from_id,r.to_id]));
    for(const item of items)if(disputed.has(item.memory_id))item.use='conflict';
  }
  const needsVerification=items.length>0&&(items.every(i=>i.use==='requires_check'||i.use==='conflict')||
    warnings.has('SOURCE_GAP'));
  const result={pack:'deterministic-v1',generation:page.generation,retrieval_mode:page.retrieval_mode,
    evidence_status:!items.length?'insufficient':needsVerification?'requires_check':'related_evidence',
    items,sources,source_families:sourceGroups.length,conflicts,warnings:[...warnings],
    has_more:page.has_more,next_cursor:page.next_cursor,remaining_ids:page.remaining_ids,
    remaining_versions:page.remaining_versions,pruned_versions:page.pruned_versions};
  const fits=(output:object)=>{
    const bytes=Buffer.byteLength(JSON.stringify(output));
    return bytes<=Math.min(config.page_response_bytes,input.max_bytes??Infinity)&&
      estimateTokens(bytes)<=Math.min(config.response_token_budget,input.token_budget??Infinity);
  };
  if(fits(result))return result;
  // Keep the original page and its cursor together when the packet envelope
  // cannot fit. Never consume a page while silently dropping supported items.
  const fallback={...page,pack:'raw_fallback'};
  return fits(fallback)?fallback:page;
}
