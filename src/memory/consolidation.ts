import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import { applicability, hash, MemoryError, type MemoryRecord, type consolidationPreviewSchema, type versionRefSchema } from '../core/contracts.js';
import { coversEffectiveTime } from './temporal.js';

type Input=z.infer<typeof consolidationPreviewSchema>;
type Ref=z.infer<typeof versionRefSchema>;
type Evidence={ref:Ref;record:MemoryRecord;origins:Set<string>};

export function previewConsolidation(db:DatabaseSync,input:Input,
  revoked:(id:string,record:MemoryRecord,contentHash:string)=>boolean) {
  const at=new Date().toISOString();
  const visited=new Map<string,Evidence>(), roots=new Map<string,Evidence>(), path=new Set<string>();
  const memory=db.prepare('SELECT body,revision,status,project_id,scope,content_hash FROM memories WHERE id=?');
  const read=(ref:Ref):Evidence=>{
    if(path.has(ref.memory_id))throw new MemoryError('DEPENDENCY_CYCLE');
    const prior=visited.get(ref.memory_id);
    if(prior) {
      if(prior.ref.revision!==ref.revision)throw new MemoryError('CONSOLIDATION_SOURCE_STALE');
      return prior;
    }
    if(visited.size>=20)throw new MemoryError('CONSOLIDATION_SPLIT_REQUIRED');
    const row=memory.get(ref.memory_id);
    if(!row || row.revision!==ref.revision || row.status!=='active')throw new MemoryError('CONSOLIDATION_SOURCE_STALE');
    if(row.scope!==input.scope || row.project_id!==input.project_id)throw new MemoryError('CONSOLIDATION_SCOPE');
    const record=JSON.parse(String(row.body)) as MemoryRecord;
    if((record.lifecycle??'current')!=='current' || !coversEffectiveTime(record.valid_time,at) ||
       applicability(record.valid_for,input.context)!=='current' || revoked(ref.memory_id,record,String(row.content_hash)))
      throw new MemoryError('CONSOLIDATION_SOURCE_STALE');
    const evidence={ref,record,origins:new Set<string>()};
    visited.set(ref.memory_id,evidence);path.add(ref.memory_id);
    if(record.derived_from.length) {
      for(const dep of record.derived_from)for(const origin of read(dep).origins)evidence.origins.add(origin);
    } else {
      roots.set(ref.memory_id,evidence);
      if(record.verification.basis!=='model_inference' && record.verification.status!=='disputed') {
        if(record.episode?.conversation_ref)evidence.origins.add('conversation:'+record.episode.conversation_ref);
        if(record.episode?.session_ref)evidence.origins.add('session:'+record.episode.session_ref);
        for(const source of record.sources) {
          evidence.origins.add('uri:'+source.uri.split('#')[0]);
          if(source.source_hash)evidence.origins.add('hash:'+source.source_hash);
        }
      }
    }
    path.delete(ref.memory_id);
    return evidence;
  };
  const citations=input.evidence.citations.map(citation=>{
    const evidence=read({memory_id:citation.memory_id,revision:citation.revision});
    const {content,sources,verification,decision_state}=evidence.record;
    const splitsPair=(index:number)=>index>0&&index<content.length&&
      /[\uD800-\uDBFF]/.test(content[index-1])&&/[\uDC00-\uDFFF]/.test(content[index]);
    if(citation.end>content.length || splitsPair(citation.start) || splitsPair(citation.end))
      throw new MemoryError('CONSOLIDATION_SPAN_INVALID');
    return {...citation,excerpt:content.slice(citation.start,citation.end),sources,verification,decision_state};
  });
  for(const key of ['subject_id','context_key'] as const)
    if(new Set([...visited.values()].flatMap(e=>e.record[key]?[e.record[key]]:[])).size>1)
      throw new MemoryError('CONSOLIDATION_CONTEXT');
  const support=citations.filter(c=>c.role==='support');
  const groups:Set<string>[]=[];
  for(const citation of support) {
    const origins=new Set(visited.get(citation.memory_id)!.origins);
    if(!origins.size)continue;
    for(let i=groups.length-1;i>=0;i--)if([...groups[i]].some(origin=>origins.has(origin))) {
      for(const origin of groups[i])origins.add(origin);
      groups.splice(i,1);
    }
    groups.push(origins);
  }
  const revs=JSON.stringify([...visited.values()].map(e=>e.ref));
  const contradictions=db.prepare(`WITH selected AS (
    SELECT json_extract(value,'$.memory_id') id,json_extract(value,'$.revision') revision FROM json_each(?)
  ) SELECT e.id,e.from_id,e.from_revision,e.to_id,e.to_revision,e.sources FROM memory_relations e
    JOIN selected a ON a.id=e.from_id AND a.revision=e.from_revision
    JOIN selected b ON b.id=e.to_id AND b.revision=e.to_revision
    WHERE e.type='contradicts' AND e.scope=? AND e.project_id IS ? ORDER BY e.id`)
    .all(revs,input.scope,input.project_id).map(row=>({...row,sources:JSON.parse(String(row.sources))}));
  const states=new Set(support.flatMap(c=>c.decision_state&&c.decision_state!=='unknown'?[c.decision_state]:[]));
  const conflicted=support.length!==citations.length||contradictions.length>0||states.size>1;
  const single=input.evidence.mode==='direct_statement';
  const direct=single&&citations.length===1&&support.length===1&&support[0].excerpt===input.claim&&
    roots.has(support[0].memory_id)&&support[0].verification.basis==='user_confirmation'&&
    support[0].verification.status!=='disputed'&&support[0].sources.some(s=>s.source_type==='user');
  const status=conflicted?'conflict':single?(direct?'direct_statement':'insufficient'):(groups.length>=2?'candidate':'insufficient');
  const conditions=[...visited.values()].map(e=>e.record);
  const byTime=(a:string,b:string)=>Date.parse(a)-Date.parse(b);
  const expires_at=conditions.flatMap(r=>r.valid_for.expires_at?[r.valid_for.expires_at]:[]).sort(byTime)[0];
  const valid_from=conditions.flatMap(r=>r.valid_time?.valid_from?[r.valid_time.valid_from]:[]).sort(byTime).at(-1);
  const valid_to=conditions.flatMap(r=>r.valid_time?.valid_to?[r.valid_time.valid_to]:[]).sort(byTime)[0];
  const sources=[...new Map([...roots.values()].flatMap(e=>e.record.sources).map(source=>[hash(source),source])).values()];
  const canDraft=status==='candidate'||status==='direct_statement'||status==='conflict'&&!single;
  if(canDraft&&sources.length>12)throw new MemoryError('CONSOLIDATION_SPLIT_REQUIRED');
  const candidate=canDraft?{
    project_id:input.project_id,scope:input.scope,kind:input.kind,title:input.title,content:input.claim,sources,
    memory_form:input.kind==='procedure'?'procedural' as const:'semantic' as const,
    ...(status==='conflict'&&{lifecycle:'quarantined' as const}),
    valid_for:{...input.context,...(expires_at&&{expires_at})},
    ...(valid_from||valid_to?{valid_time:{...(valid_from&&{valid_from}),...(valid_to&&{valid_to})}}:{}),
    derived_from:citations.map(({memory_id,revision})=>({memory_id,revision})),
    consolidation:input.evidence,
    verification:{status:'unverified' as const,basis:direct?'user_confirmation' as const:'model_inference' as const,
      method:'consolidation preview',summary:'Candidate claim for review against the cited source spans.'}
  }:null;
  return {dry_run:true,status,independent_support_groups:groups.length,citations,contradictions,
    origins:[...roots.values()].map(e=>({...e.ref,sources:e.record.sources})),candidate};
}
