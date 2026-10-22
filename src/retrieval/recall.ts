import type { DatabaseSync,SQLInputValue } from 'node:sqlite';
import { MemoryError,verificationSchema,type Config,type Encoder,type RecallInput } from '../core/contracts.js';
import { identifiers,ftsQuery,terms } from './lexical.js';

type Context={db:DatabaseSync;config:Config;encoder:Encoder;generation:()=>number};
type Candidate={id:string;rrf:number;exact:number;cosine?:number;lexical?:number;reasons:Set<string>;hits:Map<number,number>};
const CHANNEL_LIMIT=20,LEXICAL_WEIGHT=0.125,IDENTIFIER_BOOST=0.01;
const vectorBlob=(v:Float32Array)=>Buffer.from(v.buffer,v.byteOffset,v.byteLength);
export const estimateTokens=(bytes:number)=>Math.ceil(bytes/3);

// All candidate channels use this predicate BEFORE Top-K, within the same read snapshot.
function eligibility(input:RecallInput,config:Config) {
  const includeGlobal=input.include_global??(!input.project_id&&config.allow_global);
  const params:SQLInputValue[]=[Number(!input.project_id&&config.all_projects),JSON.stringify(input.project_id?[input.project_id]:config.allowed_projects),Number(includeGlobal),new Date().toISOString()];
  let sql="s.status='active' AND ((s.scope='project' AND s.project_id IN (SELECT p.id FROM projects p WHERE ?=1 OR p.id IN (SELECT value FROM json_each(?)))) OR (?=1 AND s.scope='global')) AND (s.expires_at IS NULL OR s.expires_at>?)";
  for(const [field,key]of [['branch','branch'],['commit_ref','commit'],['environment','environment']] as const){sql+=` AND (s.${field} IS NULL OR ? IS NULL OR s.${field}=?)`;params.push(input.context[key]??null,input.context[key]??null);}
  return {sql,params};
}

export async function retrieve(ctx:Context,input:RecallInput,mode:'hybrid'|'lexical'|'vector') {
  const {db,config,encoder}=ctx,started=performance.now();
  const warnings:string[]=[],diagnostics={elapsed_ms:0,candidate_ids:0,candidates_ranked:0,full_body_records_read:0,full_body_bytes_read:0,json_parses:0,metadata_json_parses:0,chunk_text_rows_read:0,vector_queries:0,vector_rows_returned:0,vector_internal_scanned:null,vector_distance_computations:null,query_embeddings:0,response_bytes:0,estimated_tokens:0,token_estimator:'ceil(utf8_bytes/3)'};
  let queryVector:Float32Array|undefined,profileId:string|undefined,retrievalMode:string=input.ids?'ids':mode;
  const parse=(value:string,metadata=false)=>{diagnostics.json_parses++;if(metadata)diagnostics.metadata_json_parses++;return JSON.parse(value);};
  if(input.query&&mode!=='lexical')try{profileId=(await encoder.profile()).id;diagnostics.query_embeddings++;queryVector=await encoder.query(input.query);}catch(error){if(error instanceof MemoryError&&error.code==='QUERY_TOO_LONG')throw error;retrievalMode='lexical_degraded';warnings.push('EMBEDDING_UNAVAILABLE');}
  const eligible=eligibility(input,config);
  db.exec('BEGIN');
  try{
    const scores=new Map<string,Candidate>(),score=(id:string)=>{if(!scores.has(id))scores.set(id,{id,rrf:0,exact:0,reasons:new Set(),hits:new Map()});return scores.get(id)!;};
    const hit=(s:Candidate,id:number,value:number)=>s.hits.set(id,Math.max(value,s.hits.get(id)??-Infinity));
    const profiles=(db.prepare(`SELECT DISTINCT s.profile_id FROM memory_search s WHERE ${eligible.sql}`).all(...eligible.params) as any[]).map(r=>r.profile_id);
    if(queryVector){
      if(profiles.some(id=>id!==profileId)){retrievalMode='lexical_degraded';warnings.push('INDEX_PROFILE_MISMATCH');}
      else try{
        const incomplete=db.prepare(`SELECT 1 FROM memory_search s WHERE ${eligible.sql} AND (
          NOT EXISTS(SELECT 1 FROM memory_chunks c WHERE c.memory_id=s.memory_id) OR
          EXISTS(SELECT 1 FROM memory_chunks c WHERE c.memory_id=s.memory_id AND (c.revision!=s.revision OR c.profile_id!=s.profile_id OR c.id NOT IN (SELECT chunk_id FROM memory_vec)))) LIMIT 1`).get(...eligible.params);
        if(incomplete)throw new MemoryError('INDEX_INCOMPLETE');
        const seen=new Set<string>(),found:{chunk_id:number;memory_id:string;distance:number}[]=[];
        // Multiple chunks must not crowd other memories out. Continue with already seen
        // memories excluded inside KNN, rather than truncating then filtering in Node.
        while(seen.size<CHANNEL_LIMIT){
          const k=Math.max(32,2*(CHANNEL_LIMIT-seen.size));
          const neighbors=db.prepare(`SELECT chunk_id,distance FROM memory_vec WHERE embedding MATCH ? AND k=? AND chunk_id IN (
            SELECT c.id FROM memory_chunks c JOIN memory_search s ON s.memory_id=c.memory_id
            WHERE ${eligible.sql} AND c.revision=s.revision AND c.profile_id=s.profile_id
            AND s.memory_id NOT IN (SELECT value FROM json_each(?))) ORDER BY distance`).all(vectorBlob(queryVector),k,...eligible.params,JSON.stringify([...seen])) as any[];
          diagnostics.vector_queries++;diagnostics.vector_rows_returned+=neighbors.length;
          if(!neighbors.length)break;
          const owners=new Map((db.prepare('SELECT id,memory_id FROM memory_chunks WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(neighbors.map(n=>n.chunk_id))) as any[]).map(c=>[c.id,c.memory_id]));
          for(const n of neighbors){const id=owners.get(n.chunk_id)!;seen.add(id);found.push({...n,memory_id:id});}
          if(neighbors.length<k)break;
        }
        found.sort((a,b)=>a.distance-b.distance||a.chunk_id-b.chunk_id);const ranked=new Map<string,number>();
        for(const row of found){
          if(!ranked.has(row.memory_id)){if(ranked.size===CHANNEL_LIMIT)continue;ranked.set(row.memory_id,ranked.size+1);}
          const s=score(row.memory_id),cosine=1-row.distance;
          if(s.cosine===undefined){s.cosine=cosine;if(cosine>=config.semantic_threshold){s.rrf+=1/(60+ranked.get(row.memory_id)!);s.reasons.add('semantic');}}
          hit(s,row.chunk_id,cosine);
        }
      }catch(error){scores.clear();retrievalMode='lexical_degraded';warnings.push(error instanceof MemoryError?error.code:'VECTOR_INDEX_UNAVAILABLE');}
    }
    if(input.query){
      if(mode!=='vector'||retrievalMode==='lexical_degraded'){
        const q=ftsQuery(input.query),seen=new Set<string>(),queryTerms=terms(input.query);
        while(q&&seen.size<CHANNEL_LIMIT){
          const k=Math.max(32,2*(CHANNEL_LIMIT-seen.size));
          const rows=db.prepare(`SELECT chunk_id,memory_id,terms,bm25(chunk_fts) AS rank FROM chunk_fts WHERE chunk_fts MATCH ?
            AND chunk_id IN (SELECT c.id FROM memory_chunks c JOIN memory_search s ON s.memory_id=c.memory_id WHERE ${eligible.sql} AND c.revision=s.revision AND c.profile_id=s.profile_id)
            AND memory_id NOT IN (SELECT value FROM json_each(?)) ORDER BY rank,chunk_id LIMIT ?`).all(q,...eligible.params,JSON.stringify([...seen]),k) as any[];
          if(!rows.length)break;
          for(const row of rows){
            if(!seen.has(row.memory_id)){
              if(seen.size===CHANNEL_LIMIT)continue;seen.add(row.memory_id);
              const s=score(row.memory_id),words=new Set(row.terms.split(' ')),coverage=queryTerms.length?queryTerms.filter(t=>words.has(t)).length/queryTerms.length:0;
              s.rrf+=LEXICAL_WEIGHT/(60+seen.size);s.lexical=row.rank;s.reasons.add(coverage>=0.6?'lexical':'lexical_weak');
            }
            if(seen.has(row.memory_id))hit(score(row.memory_id),Number(row.chunk_id),1/(60+seen.size));
          }
          if(rows.length<k)break;
        }
      }
      const ids=identifiers(input.query);
      if(ids.length&&(mode!=='vector'||input.exact_only||retrievalMode==='lexical_degraded')){
        const rows=db.prepare(`WITH matches AS MATERIALIZED (
          SELECT i.* FROM chunk_identifiers i JOIN memory_chunks c ON c.id=i.chunk_id JOIN memory_search s ON s.memory_id=i.memory_id
          WHERE i.identifier IN (SELECT value FROM json_each(?)) AND ${eligible.sql} AND c.revision=s.revision AND c.profile_id=s.profile_id
        ), per_identifier AS (SELECT memory_id,identifier,max(weight) weight FROM matches GROUP BY memory_id,identifier),
        totals AS (SELECT memory_id,sum(weight) exact FROM per_identifier GROUP BY memory_id)
        SELECT t.*,(SELECT chunk_id FROM matches h WHERE h.memory_id=t.memory_id ORDER BY weight DESC,chunk_id LIMIT 1) chunk_id
        FROM totals t ORDER BY exact DESC,memory_id LIMIT ?`).all(JSON.stringify(ids),...eligible.params,CHANNEL_LIMIT) as any[];
        for(const row of rows){const s=score(row.memory_id);s.exact=row.exact;s.reasons.add('identifier');hit(s,row.chunk_id,2+row.exact);}
      }
    }
    diagnostics.candidate_ids=scores.size;
    let ranked=input.ids??[...scores.values()].filter(s=>input.exact_only?s.exact>0:s.reasons.size>0).map(s=>s.id);
    const flags=new Map((db.prepare(`SELECT s.memory_id,(s.branch IS NOT NULL AND ? IS NULL OR s.commit_ref IS NOT NULL AND ? IS NULL OR s.environment IS NOT NULL AND ? IS NULL) requires_check
      FROM memory_search s WHERE ${eligible.sql} AND s.memory_id IN (SELECT value FROM json_each(?))`).all(input.context.branch??null,input.context.commit??null,input.context.environment??null,...eligible.params,JSON.stringify(ranked)) as any[]).map(r=>[r.memory_id,r.requires_check]));
    ranked=ranked.filter(id=>flags.has(id));
    if(!input.ids)ranked.sort((a,b)=>Number(flags.get(a))-Number(flags.get(b))||((scores.get(b)!.rrf+Math.min(scores.get(b)!.exact,3)*IDENTIFIER_BOOST)-(scores.get(a)!.rrf+Math.min(scores.get(a)!.exact,3)*IDENTIFIER_BOOST))||a.localeCompare(b));
    diagnostics.candidates_ranked=ranked.length;
    const result:any={items:[],generation:ctx.generation(),retrieval_mode:retrievalMode,index_profiles:profiles,warnings,empty_reason:null,evidence_status:'none',diagnostics};
    const tokenBudget=Math.min(input.token_budget??config.response_token_budget,config.response_token_budget);
    const fits=(reserve=0)=>{
      for(let i=0;i<4;i++){const bytes=Buffer.byteLength(JSON.stringify(result));diagnostics.response_bytes=bytes;diagnostics.estimated_tokens=estimateTokens(bytes);}
      return diagnostics.response_bytes<=Math.min(32000,tokenBudget*3)-reserve&&result.items.reduce((n:number,x:any)=>n+x.content.length,0)<=5000;
    };
    for(const id of ranked.slice(0,input.limit)){
      const row=db.prepare(`SELECT s.memory_id,s.project_id,s.scope,s.revision,s.profile_id,s.metadata,m.content_hash,m.written_by,m.verified_at${input.ids?',m.body':''}
        FROM memory_search s JOIN memories m ON m.id=s.memory_id WHERE s.memory_id=?`).get(id) as any;
      let body:any;
      if(input.ids){diagnostics.full_body_records_read++;diagnostics.full_body_bytes_read+=Buffer.byteLength(row.body);body=parse(row.body);}else body=parse(row.metadata,true);
      const s=scores.get(id),selected=input.ids?[]:[...(s?.hits??new Map())].sort((a,b)=>b[1]-a[1]||a[0]-b[0]).slice(0,2).map(x=>x[0]);
      const chunks=input.ids?[]:db.prepare('SELECT id,start,end,text FROM memory_chunks WHERE memory_id=? AND revision=? AND id IN (SELECT value FROM json_each(?)) ORDER BY start').all(id,row.revision,JSON.stringify(selected)) as any[];
      diagnostics.chunk_text_rows_read+=chunks.length;
      const excerpts:{start:number;end:number;chunk_ids:number[];text:string}[]=[];
      for(const c of chunks){const last=excerpts.at(-1);if(last&&c.start<=last.end){last.text+=c.text.slice(Math.max(0,last.end-c.start));last.end=Math.max(last.end,c.end);last.chunk_ids.push(c.id);}else excerpts.push({start:c.start,end:c.end,chunk_ids:[c.id],text:c.text});}
      if(input.ids)excerpts.push({start:0,end:body.content.length,chunk_ids:[],text:body.content});
      const strength=input.ids||s&&(s.exact>0||s.reasons.has('lexical')||(s.cosine??0)>=config.evidence_threshold)?'supported':'weak';
      const item:any={id,revision:row.revision,scope:row.scope,project_id:row.project_id,kind:body.kind,title:body.title,content:excerpts.map(e=>e.text).join('\n…\n'),tags:body.tags,evidence_strength:strength,
        sources:body.sources,verification:verificationSchema.parse(body.verification),written_by:row.written_by,record_updated_at:row.verified_at,valid_for:body.valid_for??{},applicability:flags.get(id)?'requires_check':'current',content_hash:row.content_hash,
        embedding_profile_id:row.profile_id,derived_from:body.derived_from,author_client:body.author_client,author_session:body.author_session,import_key:body.import_key,
        excerpt:{start:excerpts[0]?.start??0,end:excerpts.at(-1)?.end??0},excerpts:excerpts.map(({text,...e})=>e),recall_reason:s?[...s.reasons]:['id'],relevance:s?{rrf:s.rrf,cosine:s.cosine,identifier_matches:s.exact}:undefined};
      result.items.push(item);
      if(!fits(128)){
        if(!warnings.includes('RESPONSE_BUDGET'))warnings.push('RESPONSE_BUDGET');
        // Preserve headers and sources. Only shrink the excerpt payload, with offsets.
        const original=excerpts.map(e=>({...e}));let low=0,high=item.content.length,best=-1;
        const shorten=(length:number)=>{
          const kept=[];let remaining=length;
          for(const e of original){if(remaining<=0)break;const separator=kept.length?3:0;remaining-=separator;if(remaining<=0)break;let text=e.text.slice(0,remaining);if(/[\uD800-\uDBFF]$/.test(text))text=text.slice(0,-1);if(text){kept.push({...e,text,end:e.start+text.length});remaining-=text.length;}}
          item.content=kept.map(e=>e.text).join('\n…\n');item.excerpts=kept.map(({text,...e})=>e);item.excerpt={start:kept[0]?.start??0,end:kept.at(-1)?.end??0};item.truncated=true;
        };
        while(low<=high){const mid=Math.floor((low+high)/2);shorten(mid);if(fits(128)){best=mid;low=mid+1;}else high=mid-1;}
        if(best<1)result.items.pop();else shorten(best);
      }
    }
    result.evidence_status=result.items.some((i:any)=>i.evidence_strength==='supported')?'related_evidence':ranked.length?'insufficient':'none';
    result.empty_reason=result.items.length?null:ranked.length?'response_budget':'no_candidates';
    diagnostics.elapsed_ms=Number((performance.now()-started).toFixed(3));
    // Reserve enough for final diagnostic/status digits while packing items.
    while(!fits()&&result.items.length){result.items.pop();if(!warnings.includes('RESPONSE_BUDGET'))warnings.push('RESPONSE_BUDGET');result.evidence_status='insufficient';result.empty_reason=result.items.length?null:'response_budget';}
    fits();db.exec('COMMIT');return result;
  }catch(error){db.exec('ROLLBACK');throw error;}
}
