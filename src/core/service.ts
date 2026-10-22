import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { Storage } from '../storage/database.js';
import { BgeEncoder } from '../embedding/bge.js';
import { exactScore, ftsQuery, terms, lexicalCoverage, identifiers } from '../retrieval/lexical.js';
import { MemoryError, applicability, hash, stable, configSchema, proposeSchema, recallSchema, commitSchema, forgetSchema,
  recordSchema, type Config, type Encoder, type MemoryRecord, type Chunk } from './contracts.js';

type Row={id:string;project_id:string|null;scope:string;body:string;revision:number;status:string;created_at:string;verified_at:string;profile_id:string;content_hash:string;import_key:string|null};
const now=()=>new Date().toISOString();
const LEXICAL_RRF_WEIGHT=0.125;
const blob=(v:Float32Array)=>Buffer.from(v.buffer,v.byteOffset,v.byteLength);

export async function readConfig(path:string):Promise<Config> {
  return configSchema.parse(JSON.parse(await readFile(path,'utf8')));
}
export class MemoryService {
  storage:Storage;
  encoder:Encoder;
  constructor(public config:Config,encoder?:Encoder,private checkpoint:(point:string)=>void=()=>{}) {
    this.config=configSchema.parse(config);
    this.storage=new Storage(config.database);
    this.encoder=encoder??new BgeEncoder(config);
  }
  get db(){return this.storage.db;}
  close(){this.storage.close();}
  private permission(operation:Config['operations'][number]) {
    if(!this.config.operations.includes(operation)) throw new MemoryError('OPERATION_DENIED');
  }
  private scope(project:string|null,scope:string) {
    if(scope==='global') { if(!this.config.allow_global || project!==null) throw new MemoryError('SCOPE_DENIED'); }
    else if(!project || (!this.config.all_projects && !this.config.allowed_projects.includes(project))) throw new MemoryError('SCOPE_DENIED');
    else if(!this.db.prepare('SELECT id FROM projects WHERE id=?').get(project)) throw new MemoryError('PROJECT_UNKNOWN');
  }
  private event(request_id:string,operation:string,input:unknown) {
    const event=this.db.prepare('SELECT * FROM events WHERE request_id=?').get(request_id) as any;
    if(!event)return null;
    this.scope(event.project_id,event.scope);
    if(event.operation!==operation || event.request_hash!==hash(input)) throw new MemoryError('REQUEST_ID_REUSED');
    return JSON.parse(event.result);
  }
  private receipt(request_id:string,operation:string,input:unknown,project:string|null,scope:string,result:unknown) {
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(request_id,operation,hash(input),project,scope,JSON.stringify(result),now());
  }
  private find(id:string):Row {
    const row=this.db.prepare('SELECT * FROM memories WHERE id=?').get(id) as Row|undefined;
    if(!row)throw new MemoryError('MEMORY_NOT_FOUND');
    this.scope(row.project_id,row.scope);
    return row;
  }
  async project(id:string,name:string,alias:string) {
    this.permission('manage');
    if(!this.config.all_projects && !this.config.allowed_projects.includes(id))throw new MemoryError('SCOPE_DENIED');
    const path=await realpath(alias);
    return this.storage.transaction(()=>{
      const projects=this.db.prepare('SELECT * FROM projects').all() as any[];
      if(projects.some(x=>x.id!==id && JSON.parse(x.aliases).includes(path)))throw new MemoryError('ALIAS_CONFLICT');
      const existing=projects.find(x=>x.id===id);
      const aliases=[...new Set([...(existing?JSON.parse(existing.aliases):[]),path])];
      this.db.prepare('INSERT INTO projects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,aliases=excluded.aliases').run(id,name,JSON.stringify(aliases));
      return {project_id:id,name,aliases};
    });
  }
  async resolveProject(path:string) {
    this.permission('manage');
    const absolute=await realpath(path);
    const matches=(this.db.prepare('SELECT * FROM projects').all() as any[]).filter(p=>this.config.all_projects || this.config.allowed_projects.includes(p.id)).flatMap(p=>JSON.parse(p.aliases).filter((a:string)=>absolute===a || absolute.startsWith(a+'/')).map((a:string)=>({project_id:p.id,alias:a})));
    matches.sort((a,b)=>b.alias.length-a.alias.length);
    return matches[0]??{project_id:null};
  }
  private dependencies(record:MemoryRecord,target?:string) {
    for(const dep of record.derived_from) {
      const parent=this.find(dep.memory_id);
      if(parent.status!=='active' || parent.revision!==dep.revision || applicability(JSON.parse(parent.body).valid_for,{})==='excluded')throw new MemoryError('DEPENDENCY_STALE');
      if(record.scope==='global' && parent.scope!=='global')throw new MemoryError('DEPENDENCY_SCOPE');
      if(parent.scope==='project' && parent.project_id!==record.project_id)throw new MemoryError('DEPENDENCY_SCOPE');
      if(target) {
        const cycle=this.db.prepare(`WITH RECURSIVE ancestors(id) AS(SELECT ? UNION SELECT d.parent_id FROM dependencies d JOIN ancestors a ON d.child_id=a.id) SELECT id FROM ancestors WHERE id=?`).get(dep.memory_id,target);
        if(cycle)throw new MemoryError('DEPENDENCY_CYCLE');
      }
    }
  }
  private sourceCheck(record:MemoryRecord) {
    if(record.sources.some(s=>Date.parse(s.checked_at)>Date.now()+300000))throw new MemoryError('SOURCE_DATE_INVALID');
    if(/\b(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16})\b|(?:authorization\s*:\s*bearer|cookie\s*:|password\s*=)/i.test(stable(record)))throw new MemoryError('SECRET_REJECTED');
  }
  async propose(raw:unknown,importTarget?:{id:string;revision:number}) {
    this.permission('propose');
    if(importTarget)this.permission('manage');
    const input=proposeSchema.parse(raw),record=input.record;
    const fingerprint={...input,record:{...record}};
    this.scope(record.project_id,record.scope); this.sourceCheck(record);
    return this.storage.transaction(()=>{
      const retry=this.event(input.request_id,'propose',fingerprint); if(retry)return retry;
      if(input.target_id) {
        const target=this.find(input.target_id);
        if(target.status!=='active' || target.revision!==input.expected_revision)throw new MemoryError('VERSION_CONFLICT');
        if(target.scope!==record.scope || target.project_id!==record.project_id)throw new MemoryError('SCOPE_IMMUTABLE');
        const previous:MemoryRecord=JSON.parse(target.body);
        const supplied=(raw as any).record;
        for(const key of ['tags','valid_for','derived_from','import_key'] as const) {
          if(!Object.hasOwn(supplied,key) && previous[key]!==undefined)(record as any)[key]=previous[key];
        }
      }
      this.dependencies(record,input.target_id);
      const contentHash=hash(record);
      if(this.db.prepare('SELECT id FROM tombstones WHERE content_hash=? OR (? IS NOT NULL AND import_key=?)').get(contentHash,record.import_key??null,record.import_key??null))throw new MemoryError('REVOKED_IMPORT');
      if(record.import_key) {
        const duplicate=this.db.prepare('SELECT id,revision,project_id,scope FROM memories WHERE import_key=?').get(record.import_key) as any;
        if(duplicate && duplicate.id!==input.target_id)throw new MemoryError('IMPORT_ALREADY_EXISTS');
      }
      const similarQuery=ftsQuery(record.title+' '+record.content);
      const candidates=similarQuery?this.db.prepare("SELECT m.id,m.revision,m.body FROM memories_fts f JOIN memories m ON m.id=f.memory_id WHERE memories_fts MATCH ? AND m.status='active' AND m.scope=? AND m.project_id IS ? ORDER BY bm25(memories_fts) LIMIT 20").all(similarQuery,record.scope,record.project_id) as any[]:[];
      const words=new Set(terms(record.title+' '+record.content));
      const similar=candidates.map(x=>({memory_id:x.id,revision:x.revision,overlap:terms(JSON.parse(x.body).title+' '+JSON.parse(x.body).content).filter(w=>words.has(w)).length})).filter(x=>x.overlap>=3).sort((a,b)=>b.overlap-a.overlap).slice(0,5);
      const id=randomUUID();
      this.db.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?,?)').run(id,record.project_id,record.scope,JSON.stringify(record),input.target_id??null,input.expected_revision??0,'pending',now());
      if(importTarget)this.db.prepare('INSERT INTO import_targets VALUES(?,?,?)').run(id,importTarget.id,importTarget.revision);
      const result={proposal_id:id,expected_revision:input.expected_revision??0,similar_candidates:similar,missing_fields:[],warning:'Similarity does not establish contradiction or permission to merge.'};
      this.receipt(input.request_id,'propose',fingerprint,record.project_id,record.scope,result);
      return result;
    });
  }
  private deleteIndexes(id:string) {
    const chunks=this.db.prepare('SELECT id FROM memory_chunks WHERE memory_id=?').all(id) as any[];
    for(const c of chunks)this.db.prepare('DELETE FROM memory_vec WHERE chunk_id=?').run(BigInt(c.id));
    this.db.prepare('DELETE FROM memory_chunks WHERE memory_id=?').run(id);
    this.db.prepare('DELETE FROM memories_fts WHERE memory_id=?').run(id);
  }
  private descendants(id:string) {
    return (this.db.prepare(`WITH RECURSIVE children(id) AS(SELECT child_id FROM dependencies WHERE parent_id=? UNION SELECT d.child_id FROM dependencies d JOIN children c ON d.parent_id=c.id) SELECT id FROM children`).all(id) as any[]).map(x=>x.id as string);
  }
  private invalidate(ids:string[],erase:boolean) {
    for(const id of ids) {
      this.deleteIndexes(id);
      if(erase) {
        const row=this.db.prepare('SELECT * FROM memories WHERE id=?').get(id) as Row|undefined;
        if(row) {
          this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES(?,?,?,?,?,?,?)').run(id,row.project_id,row.scope,row.revision,row.import_key,row.content_hash,now());
          this.db.prepare('DELETE FROM memories WHERE id=?').run(id);
        }
      } else this.db.prepare("UPDATE memories SET status='invalidated' WHERE id=?").run(id);
    }
    for(const p of this.db.prepare("SELECT id,target_id,body FROM proposals WHERE status='pending'").all() as any[]) {
      const r:MemoryRecord=JSON.parse(p.body);
      if(ids.includes(p.target_id) || r.derived_from.some(d=>ids.includes(d.memory_id)))this.db.prepare("UPDATE proposals SET body=NULL,status='invalidated' WHERE id=?").run(p.id);
    }
  }
  async commit(raw:unknown) {
    this.permission('commit'); const input=commitSchema.parse(raw);
    const retry=this.event(input.request_id,'commit',input); if(retry)return retry;
    const proposal=this.db.prepare('SELECT * FROM proposals WHERE id=?').get(input.proposal_id) as any;
    if(!proposal)throw new MemoryError('PROPOSAL_NOT_FOUND');
    this.scope(proposal.project_id,proposal.scope);
    if(proposal.status!=='pending')throw new MemoryError('PROPOSAL_NOT_PENDING');
    if(proposal.expected_revision!==input.expected_revision)throw new MemoryError('VERSION_CONFLICT');
    const record:MemoryRecord=JSON.parse(proposal.body); this.sourceCheck(record);this.dependencies(record,proposal.target_id);
    let chunks,profile;
    try { profile=await this.encoder.profile(); chunks=await this.encoder.chunks(record.title,record.content); }
    catch(error) { if(error instanceof MemoryError && error.code==='QUERY_TOO_LONG')throw error;throw new MemoryError('EMBEDDING_UNAVAILABLE'); }
    this.checkpoint('after_embedding');
    return this.storage.transaction(()=>{
      this.checkpoint('begin');
      const repeated=this.event(input.request_id,'commit',input);if(repeated)return repeated;
      const current=this.db.prepare('SELECT * FROM proposals WHERE id=?').get(input.proposal_id) as any;
      if(!current || current.status!=='pending' || current.body!==proposal.body)throw new MemoryError('PROPOSAL_NOT_PENDING');
      this.scope(record.project_id,record.scope); this.dependencies(record,proposal.target_id);
      const otherProfile=this.db.prepare("SELECT profile_id FROM memories WHERE status='active' AND profile_id!=? LIMIT 1").get(profile.id);
      if(otherProfile)throw new MemoryError('INDEX_PROFILE_MISMATCH');
      const imported=this.db.prepare('SELECT * FROM import_targets WHERE proposal_id=?').get(proposal.id) as any;
      const id=proposal.target_id??imported?.memory_id??randomUUID();
      const old=proposal.target_id?this.find(id):null;
      if(old && (old.revision!==input.expected_revision || old.status!=='active'))throw new MemoryError('VERSION_CONFLICT');
      if(this.db.prepare('SELECT id FROM tombstones WHERE id=? OR content_hash=? OR (? IS NOT NULL AND import_key=?)').get(id,hash(record),record.import_key??null,record.import_key??null))throw new MemoryError('REVOKED_IMPORT');
      this.db.prepare('INSERT OR IGNORE INTO embedding_profiles VALUES(?,?)').run(profile.id,JSON.stringify(profile.manifest));
      this.checkpoint('profile');
      if(!old && this.db.prepare('SELECT id FROM memories WHERE id=?').get(id))throw new MemoryError('IMPORT_ID_CONFLICT');
      const revision=old?old.revision+1:imported?.revision??1;
      if(old) {this.invalidate(this.descendants(id),false);this.deleteIndexes(id);}
      this.checkpoint('index_delete');
      this.db.prepare(`INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,revision=excluded.revision,status=excluded.status,verified_at=excluded.verified_at,profile_id=excluded.profile_id,content_hash=excluded.content_hash,import_key=excluded.import_key`).run(id,record.project_id,record.scope,JSON.stringify(record),revision,'active',old?.created_at??now(),now(),profile.id,hash(record),record.import_key??null);
      this.checkpoint('row');
      this.db.prepare('DELETE FROM dependencies WHERE child_id=?').run(id);
      for(const dep of record.derived_from)this.db.prepare('INSERT INTO dependencies VALUES(?,?,?)').run(id,dep.memory_id,dep.revision);
      this.checkpoint('dependencies');
      for(const c of chunks) {
        const result=this.db.prepare('INSERT INTO memory_chunks(memory_id,revision,start,end,tokens,text,profile_id) VALUES(?,?,?,?,?,?,?)').run(id,revision,c.start,c.end,c.tokens,c.text,profile.id);
        this.db.prepare('INSERT INTO memory_vec VALUES(?,?,?)').run(BigInt(result.lastInsertRowid),blob(c.vector),record.project_id??'global');
      }
      this.checkpoint('chunks');
      this.db.prepare('INSERT INTO memories_fts VALUES(?,?)').run(id,terms(record.title+' '+record.content+' '+record.tags.join(' ')).join(' '));
      this.checkpoint('fts');
      this.db.prepare("UPDATE proposals SET status='committed',body=NULL WHERE id=?").run(proposal.id);
      this.checkpoint('proposal');
      const result={memory_id:id,revision,generation:this.storage.advance(),embedding_profile_id:profile.id};
      this.receipt(input.request_id,'commit',input,record.project_id,record.scope,result);this.checkpoint('receipt');return result;
    });
  }
  async recall(raw:unknown,mode:'hybrid'|'lexical'|'vector'='hybrid') {
    this.permission('recall');const input=recallSchema.parse(raw);
    if(input.project_id)this.scope(input.project_id,'project');
    const includeGlobal=input.include_global??(!input.project_id && this.config.allow_global);
    if(includeGlobal)this.scope(null,'global');
    let queryVector:Float32Array|undefined,profileId:string|undefined;
    const warnings:string[]=[];
    let retrievalMode:string=input.ids?'ids':mode;
    if(input.query && mode!=='lexical') {
      try {profileId=(await this.encoder.profile()).id;queryVector=await this.encoder.query(input.query);}
      catch(error) {
        if(error instanceof MemoryError && error.code==='QUERY_TOO_LONG')throw error;
        retrievalMode='lexical_degraded';warnings.push('EMBEDDING_UNAVAILABLE');
      }
    }
    // Start the SQLite snapshot after encoding; read all channels from this snapshot.
    this.db.exec('BEGIN');
    try {
      const generation=this.storage.generation();
      const projects=input.project_id?[input.project_id]:this.config.all_projects?(this.db.prepare('SELECT id FROM projects').all() as {id:string}[]).map(p=>p.id):this.config.allowed_projects;
      let rows=this.db.prepare("SELECT * FROM memories WHERE status='active' AND ((scope='project' AND project_id IN (SELECT value FROM json_each(?))) OR (?=1 AND scope='global'))").all(JSON.stringify(projects),Number(includeGlobal)) as Row[];
      rows=rows.filter(row=>applicability(JSON.parse(row.body).valid_for,input.context)!=='excluded');
      const eligible=new Map(rows.map(r=>[r.id,r]));
      if(input.ids)rows=input.ids.flatMap(id=>eligible.has(id)?[eligible.get(id)!]:[]);
      const scores=new Map<string,{rrf:number;exact:number;cosine?:number;lexical?:number;reason:string[];chunk?:any}>();
      const score=(id:string)=>{if(!scores.has(id))scores.set(id,{rrf:0,exact:0,reason:[]});return scores.get(id)!;};
      if(input.query) {
        const allowed=JSON.stringify([...eligible.keys()]);
        if(mode!=='vector' || retrievalMode==='lexical_degraded') {
          const q=ftsQuery(input.query);
          const lexical=q?this.db.prepare(`SELECT memory_id,bm25(memories_fts) AS rank FROM memories_fts WHERE memories_fts MATCH ? AND memory_id IN (SELECT value FROM json_each(?)) ORDER BY rank LIMIT 20`).all(q,allowed) as any[]:[];
          lexical.forEach((r,i)=>{const body:MemoryRecord=JSON.parse(eligible.get(r.memory_id)!.body);const s=score(r.memory_id);s.rrf+=LEXICAL_RRF_WEIGHT/(60+i+1);s.lexical=r.rank;s.reason.push(lexicalCoverage(input.query!,body.title+' '+body.content+' '+body.tags.join(' '))>=0.6?'lexical':'lexical_weak');});
          for(const row of rows) {
            const body:MemoryRecord=JSON.parse(row.body),exact=exactScore(input.query,body.title,body.content,body.tags);
            if(exact){const s=score(row.id);s.exact=exact;s.reason.push('identifier');}
          }
        }
        if(queryVector) {
          if(rows.some(r=>r.profile_id!==profileId)) {retrievalMode='lexical_degraded';warnings.push('INDEX_PROFILE_MISMATCH');}
          else {
            try {
              const chunks=this.db.prepare('SELECT id,memory_id,revision,profile_id FROM memory_chunks WHERE memory_id IN (SELECT value FROM json_each(?))').all(allowed) as any[];
              const vectorIds=new Set((this.db.prepare('SELECT chunk_id FROM memory_vec WHERE chunk_id IN (SELECT id FROM memory_chunks WHERE memory_id IN (SELECT value FROM json_each(?)))').all(allowed) as any[]).map(v=>v.chunk_id));
              const indexed=new Set(chunks.map(c=>c.memory_id));
              if(rows.some(r=>!indexed.has(r.id)) || chunks.some(c=>!vectorIds.has(c.id) || c.revision!==eligible.get(c.memory_id)!.revision || c.profile_id!==profileId))throw new MemoryError('INDEX_INCOMPLETE');
              // Scan the vector table once. A chunk-first join makes vec0 perform
              // thousands of separate lookups. Eligible IDs still filter BEFORE ranking.
              const vectors=this.db.prepare(`SELECT c.memory_id,c.text,c.start,c.end,vec_distance_cosine(v.embedding,?) AS distance FROM memory_vec v CROSS JOIN memory_chunks c ON c.id=v.chunk_id WHERE v.chunk_id IN (SELECT id FROM memory_chunks WHERE memory_id IN (SELECT value FROM json_each(?)) AND profile_id=?) ORDER BY distance`).all(blob(queryVector),allowed,profileId!) as any[];
              const seen=new Set<string>(); let rank=0;
              for(const v of vectors) {
                if(seen.has(v.memory_id))continue;seen.add(v.memory_id);rank++;
                if(rank>20)break;
                const s=score(v.memory_id);s.cosine=1-v.distance;s.chunk=v;
                if(s.cosine>=this.config.semantic_threshold) {s.rrf+=1/(60+rank);s.reason.push('semantic');}
              }
            } catch(error) {
              retrievalMode='lexical_degraded';warnings.push(error instanceof MemoryError?error.code:'VECTOR_INDEX_UNAVAILABLE');
            }
          }
        }
        const exactRequested=mode!=='vector' && identifiers(input.query).length>0;
        rows=rows.filter(r=>{const s=scores.get(r.id);return s && (exactRequested?s.exact>0:(s.reason.includes('semantic') || s.reason.includes('lexical') || s.reason.includes('lexical_weak')));});
        rows.sort((a,b)=>{const sa=score(a.id),sb=score(b.id);return sb.exact-sa.exact || sb.rrf-sa.rrf || a.id.localeCompare(b.id);});
      }
      const index_profiles=[...new Set([...eligible.values()].map(r=>r.profile_id))];
      const result:any={items:[],generation,retrieval_mode:retrievalMode,index_profiles,warnings,empty_reason:null};
      let characters=0;
      for(const row of rows.slice(0,input.limit)) {
        const body:MemoryRecord=JSON.parse(row.body),s=scores.get(row.id);
        const chunk=s?.chunk??this.db.prepare('SELECT text,start,end FROM memory_chunks WHERE memory_id=? ORDER BY id LIMIT 1').get(row.id) as any;
        const content=input.ids?body.content:(chunk?.text??body.content);
        if(characters+content.length>5000)break;
        const strength=input.ids || (s && (s.exact>0 || s.reason.includes('lexical') || (s.cosine??0)>=this.config.evidence_threshold))?'supported':'weak';
        const item={id:row.id,revision:row.revision,scope:row.scope,project_id:row.project_id,kind:body.kind,title:body.title,content,tags:body.tags,evidence_strength:strength,
          sources:body.sources,verification:body.verification,verified_at:row.verified_at,valid_for:body.valid_for,
          applicability:applicability(body.valid_for,input.context),content_hash:row.content_hash,
          embedding_profile_id:row.profile_id,derived_from:body.derived_from,author_client:body.author_client,author_session:body.author_session,import_key:body.import_key,
          excerpt:{start:input.ids?0:chunk?.start??0,end:input.ids?body.content.length:chunk?.end??body.content.length},
          recall_reason:s?.reason??['id'],relevance:s?{rrf:s.rrf,cosine:s.cosine,identifier_matches:s.exact}:undefined};
        result.items.push(item);
        if(Buffer.byteLength(JSON.stringify(result))>32000){result.items.pop();warnings.push('RESPONSE_BUDGET');break;}
        characters+=content.length;
      }
      result.evidence_status=result.items.some((i:any)=>i.evidence_strength==='supported')?'related_evidence':result.items.length?'insufficient':'none';
      if(result.evidence_status==='insufficient')warnings.push('WEAK_RELEVANCE_VERIFY_SOURCE_BEFORE_USE');
      if(result.items.length===0)result.empty_reason='NO_VISIBLE_APPLICABLE_EVIDENCE';
      this.db.exec('COMMIT');return result;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  async forget(raw:unknown) {
    this.permission('forget');const input=forgetSchema.parse(raw);
    const result=this.storage.transaction(()=>{
      const retry=this.event(input.request_id,'forget',input);if(retry)return retry;
      const row=this.find(input.memory_id);
      if(row.revision!==input.expected_revision)throw new MemoryError('VERSION_CONFLICT');
      const children=this.descendants(row.id),all=[row.id,...children];
      this.invalidate(all,true);
      this.db.prepare("INSERT OR REPLACE INTO meta VALUES('revocations_pending',1)").run();
      for(const entry of this.db.prepare("SELECT * FROM exports WHERE status!='removed'").all() as any[]) {
        if(JSON.parse(entry.ids).some((id:string)=>all.includes(id)))this.db.prepare("UPDATE exports SET status='pending_cleanup' WHERE id=?").run(entry.id);
      }
      const result={memory_id:row.id,forgotten:true,derived_erased:children.length,generation:this.storage.advance(),managed_copies:'pending_check',outside_control:['prior chat/tool context','unmanaged backups','OS snapshots','SSD forensic erasure']};
      this.receipt(input.request_id,'forget',input,row.project_id,row.scope,result);return result;
    });
    return {...result,maintenance:await this.maintenance()};
  }
  async maintenance() {
    const errors:string[]=[];
    // Serialize filesystem maintenance with exporters/forgetters; no asynchronous gap.
    this.storage.transaction(()=>{
      for(const entry of this.db.prepare("SELECT * FROM exports WHERE status IN ('pending_cleanup','pending_write')").all() as any[]) {
        try {unlinkSync(entry.path);this.db.prepare("UPDATE exports SET status='removed' WHERE id=?").run(entry.id);}
        catch(e:any) {if(e.code==='ENOENT')this.db.prepare("UPDATE exports SET status='removed' WHERE id=?").run(entry.id);else errors.push('EXPORT_CLEANUP_PENDING');}
      }
      try{this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('optimize')");}catch{errors.push('FTS_CLEANUP_PENDING');}
      try {
        const root=dirname(this.config.database);mkdirSync(root,{recursive:true,mode:0o700});
        const tombstones=this.db.prepare('SELECT * FROM tombstones ORDER BY id').all();
        const target=join(root,'revocations.jsonl');
        writeFileSync(target+'.tmp',tombstones.map(t=>JSON.stringify(t)).join('\n')+'\n',{mode:0o600});renameSync(target+'.tmp',target);
        this.db.prepare("INSERT OR REPLACE INTO meta VALUES('revocations_pending',0)").run();
      }catch{errors.push('REVOCATIONS_UNSYNCED_RESTORE_FORBIDDEN');}
    });
    try{const checkpoint=this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as any;if(checkpoint.busy || checkpoint.log>0)errors.push('WAL_CLEANUP_PENDING');}catch{errors.push('WAL_CLEANUP_PENDING');}
    return {managed_exports_pending:Number((this.db.prepare("SELECT count(*) AS n FROM exports WHERE status IN ('pending_cleanup','pending_write')").get() as any).n),revocations_synced:!errors.includes('REVOCATIONS_UNSYNCED_RESTORE_FORBIDDEN'),errors};
  }
  async discardProposal(id:string) {
    this.permission('manage');return this.storage.transaction(()=>{
      const p=this.db.prepare('SELECT * FROM proposals WHERE id=?').get(id) as any;
      if(!p)throw new MemoryError('PROPOSAL_NOT_FOUND');this.scope(p.project_id,p.scope);
      this.db.prepare("UPDATE proposals SET body=NULL,status='discarded' WHERE id=? AND status='pending'").run(id);return {discarded:id};
    });
  }
  inspect() {
    this.permission('manage');
    const projects=(this.db.prepare('SELECT * FROM projects').all() as any[]).filter(p=>this.config.all_projects || this.config.allowed_projects.includes(p.id));
    const counts=this.db.prepare("SELECT scope,project_id,status,count(*) AS count FROM memories GROUP BY scope,project_id,status").all().filter((r:any)=>(r.scope==='global'?this.config.allow_global:this.config.all_projects || this.config.allowed_projects.includes(r.project_id)));
    return {schema:3,generation:this.storage.generation(),projects,counts};
  }
  check() {
    this.permission('manage');
    const integrity=this.db.prepare('PRAGMA integrity_check').all();
    const orphan_chunks=this.db.prepare("SELECT count(*) AS n FROM memory_chunks c LEFT JOIN memories m ON m.id=c.memory_id WHERE m.id IS NULL OR m.status!='active' OR m.revision!=c.revision OR m.profile_id!=c.profile_id").get();
    const orphan_vectors=this.db.prepare('SELECT count(*) AS n FROM memory_vec v LEFT JOIN memory_chunks c ON c.id=v.chunk_id WHERE c.id IS NULL').get();
    const missing_vectors=this.db.prepare('SELECT count(*) AS n FROM memory_chunks c LEFT JOIN memory_vec v ON c.id=v.chunk_id WHERE v.chunk_id IS NULL').get();
    const unindexed=this.db.prepare("SELECT count(*) AS n FROM memories m WHERE status='active' AND (NOT EXISTS(SELECT 1 FROM memory_chunks c WHERE c.memory_id=m.id) OR NOT EXISTS(SELECT 1 FROM memories_fts f WHERE f.memory_id=m.id))").get();
    return {integrity,orphan_chunks,orphan_vectors,missing_vectors,unindexed};
  }
  async export(project_id:string,include_global=false,format:'json'|'markdown'='json') {
    this.permission('manage');this.scope(project_id,'project');if(include_global)this.scope(null,'global');
    const id=randomUUID(),root=join(dirname(this.config.database),'exports');await mkdir(root,{recursive:true,mode:0o700});
    const path=join(root,id+(format==='json'?'.json':'.md'));
    // Register the path durably BEFORE it can contain a body. Crash leftovers stay managed.
    this.storage.transaction(()=>this.db.prepare('INSERT INTO exports VALUES(?,?,?,?)').run(id,path,'[]','pending_write'));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows=this.db.prepare("SELECT * FROM memories WHERE status='active' AND (project_id=? OR (?=1 AND scope='global'))").all(project_id,Number(include_global)) as Row[];
      const data={schema:1,generation:this.storage.generation(),export_id:id,memories:rows.map(r=>({id:r.id,revision:r.revision,content_hash:r.content_hash,record:JSON.parse(r.body)})),revocations:this.db.prepare('SELECT * FROM tombstones WHERE project_id=? OR (?=1 AND scope=\'global\')').all(project_id,Number(include_global))};
      const content=format==='json'?JSON.stringify(data,null,2):data.memories.map(m=>`# ${m.record.title}\n\nID: ${m.id}; revision: ${m.revision}\n\n${m.record.content}\n\n${m.record.sources.map((s:any)=>`${s.uri} — ${s.locator} (${s.revision_ref})`).join('\n')}\n`).join('\n');
      const current=this.db.prepare('SELECT status FROM exports WHERE id=?').get(id) as any;
      if(current.status!=='pending_write')throw new MemoryError('EXPORT_CANCELLED');
      writeFileSync(path,content,{mode:0o600,flag:'wx'});
      this.db.prepare("UPDATE exports SET status='active',ids=? WHERE id=?").run(JSON.stringify(rows.map(r=>r.id)),id);
      this.db.exec('COMMIT');return {export_id:id,path,records:rows.length};
    }catch(error){this.db.exec('ROLLBACK');try{unlinkSync(path);}catch{}throw error;}
  }
  async reindex() {
    this.permission('manage');
    const generation=this.storage.generation();
    // Reindex is a whole-database maintenance operation; reject partial project authority.
    for(const p of this.db.prepare('SELECT id FROM projects').all() as any[])if(!this.config.all_projects && !this.config.allowed_projects.includes(p.id))throw new MemoryError('MAINTENANCE_SCOPE_DENIED');
    if(this.db.prepare("SELECT id FROM memories WHERE scope='global' LIMIT 1").get()&&!this.config.allow_global)throw new MemoryError('MAINTENANCE_SCOPE_DENIED');
    const rows=this.db.prepare("SELECT * FROM memories WHERE status='active'").all() as Row[];
    const profile=await this.encoder.profile(),encoded:{row:Row;chunks:Chunk[]}[]=[];
    for(const row of rows){const body=JSON.parse(row.body);encoded.push({row,chunks:await this.encoder.chunks(body.title,body.content)});}
    return this.storage.transaction(()=>{
      if(this.storage.generation()!==generation)throw new MemoryError('VERSION_CONFLICT');
      this.db.exec('DELETE FROM memory_vec; DELETE FROM memory_chunks; DELETE FROM memories_fts;');
      this.db.prepare('INSERT OR IGNORE INTO embedding_profiles VALUES(?,?)').run(profile.id,JSON.stringify(profile.manifest));
      for(const {row,chunks} of encoded) {
        const body=JSON.parse(row.body);
        this.db.prepare('UPDATE memories SET profile_id=? WHERE id=?').run(profile.id,row.id);
        for(const c of chunks){const r=this.db.prepare('INSERT INTO memory_chunks(memory_id,revision,start,end,tokens,text,profile_id) VALUES(?,?,?,?,?,?,?)').run(row.id,row.revision,c.start,c.end,c.tokens,c.text,profile.id);this.db.prepare('INSERT INTO memory_vec VALUES(?,?,?)').run(BigInt(r.lastInsertRowid),blob(c.vector),row.project_id??'global');}
        this.db.prepare('INSERT INTO memories_fts VALUES(?,?)').run(row.id,terms(body.title+' '+body.content+' '+body.tags.join(' ')).join(' '));
      }
      return {reindexed:rows.length,profile_id:profile.id,generation:this.storage.advance()};
    });
  }
  previewImport(entry:any) {
    this.permission('manage');const record=recordSchema.parse(entry.record??entry);
    this.scope(record.project_id,record.scope);this.sourceCheck(record);
    const import_key=record.import_key??'source:'+hash(record.sources.map(s=>({uri:s.uri,locator:s.locator})));
    const normalized={...record,import_key};
    const existing=this.db.prepare('SELECT * FROM memories WHERE import_key=? OR id=?').get(import_key,entry.id??'') as Row|undefined;
    if(existing)this.scope(existing.project_id,existing.scope);
    const revoked=this.db.prepare('SELECT id FROM tombstones WHERE import_key=? OR id=? OR content_hash=?').get(import_key,entry.id??'',hash(normalized));
    let action=revoked?'blocked_revoked':existing?(existing.content_hash===hash(normalized)?'unchanged':'update'):'create';
    if(existing && (existing.project_id!==record.project_id || existing.scope!==record.scope))action='blocked_scope';
    if(existing && entry.revision && existing.revision!==entry.revision && action!=='unchanged')action='blocked_revision';
    return {record:normalized,existing_id:existing?.id,existing_revision:existing?.revision,import_key,source_hash:hash(record.sources),action};
  }
  async importEntry(entry:any) {
    const preview=this.previewImport(entry);
    if(preview.action.startsWith('blocked'))throw new MemoryError('IMPORT_'+preview.action.toUpperCase());
    if(preview.action==='unchanged')return {memory_id:preview.existing_id,revision:preview.existing_revision,unchanged:true};
    let imported;
    if(entry.id && !preview.existing_id) {
      if(!/^[a-f0-9-]{36}$/i.test(entry.id)||!Number.isSafeInteger(entry.revision)||entry.revision<1)throw new MemoryError('IMPORT_METADATA_INVALID');
      imported={id:entry.id,revision:entry.revision};
    }
    const p=await this.propose({request_id:randomUUID(),record:preview.record,...(preview.existing_id?{target_id:preview.existing_id,expected_revision:preview.existing_revision}:{})},imported);
    return this.commit({request_id:randomUUID(),proposal_id:p.proposal_id,expected_revision:p.expected_revision});
  }
  async applyRevocations(entries:any[]) {
    this.permission('manage');
    return this.storage.transaction(()=>{
      for(const t of entries) {
        this.scope(t.project_id,t.scope);
        if(typeof t.id!=='string' || !Number.isSafeInteger(t.revision) || typeof t.content_hash!=='string' || !/^[a-f0-9]{64}$/.test(t.content_hash))throw new MemoryError('REVOCATION_INVALID');
        const current=this.db.prepare('SELECT project_id,scope FROM memories WHERE id=?').get(t.id) as any;
        if(current){this.scope(current.project_id,current.scope);if(current.project_id!==t.project_id||current.scope!==t.scope)throw new MemoryError('REVOCATION_SCOPE_MISMATCH');}
        this.invalidate([t.id,...this.descendants(t.id)],true);
        for(const entry of this.db.prepare("SELECT * FROM exports WHERE status!='removed'").all() as any[]) {
          if(JSON.parse(entry.ids).includes(t.id) || JSON.parse(entry.ids).some((id:string)=>this.db.prepare('SELECT id FROM tombstones WHERE id=?').get(id)))this.db.prepare("UPDATE exports SET status='pending_cleanup' WHERE id=?").run(entry.id);
        }
        this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES(?,?,?,?,?,?,?)').run(t.id,t.project_id,t.scope,t.revision,t.import_key??null,t.content_hash,t.forgotten_at??now());
      }
      this.db.prepare("INSERT OR REPLACE INTO meta VALUES('revocations_pending',1)").run();
      return {revocations_applied:entries.length,generation:this.storage.advance()};
    });
  }
}
