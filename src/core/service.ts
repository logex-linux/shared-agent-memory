import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink, realpath,stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { Storage } from '../storage/database.js';
import { indexChunk } from '../retrieval/indexes.js';
import { QueryState, authority } from '../retrieval/state.js';
import { retrieve } from '../retrieval/recall.js';
import { BgeEncoder } from '../embedding/bge.js';
import { ftsQuery, terms, identifiers } from '../retrieval/lexical.js';
import { recordHash } from '../memory/versions.js';
import { parseArchive, VERSION_ARCHIVE } from '../memory/archive.js';
import { coversEffectiveTime } from '../memory/temporal.js';
import { supersededRecord, validateTransition, type TransitionPlan } from '../memory/transitions.js';
import { projectFeedback, recordFeedback } from '../memory/feedback.js';
import { revokeVersions } from '../memory/erasure.js';
import { previewConsolidation } from '../memory/consolidation.js';
import { MemoryError, applicability, hash, stable, configSchema, proposeSchema, recallSchema, commitSchema, forgetSchema, feedbackSchema,
  recordSchema, consolidationPreviewSchema, type Config, type Encoder, type MemoryRecord, type Chunk } from './contracts.js';

type Row={id:string;project_id:string|null;scope:string;body:string;revision:number;status:string;created_at:string;verified_at:string;profile_id:string;content_hash:string;import_key:string|null;written_by:string};
const now=()=>new Date().toISOString();
const blob=(v:Float32Array)=>Buffer.from(v.buffer,v.byteOffset,v.byteLength);

export async function readConfig(path:string):Promise<Config> {
  const raw=JSON.parse(await readFile(path,'utf8'));
  return configSchema.parse({...raw,connection_id:raw.connection_id??'config:'+hash(await realpath(path)).slice(0,24)});
}
export class MemoryService {
  private revocationsChecked=false;
  storage:Storage;
  encoder:Encoder;
  constructor(public config:Config,encoder?:Encoder,private checkpoint:(point:string)=>void=()=>{}) {
    this.config=configSchema.parse(config);
    this.storage=new Storage(config.database,checkpoint);
    this.encoder=encoder??new BgeEncoder(this.config);
  }
  get db(){return this.storage.db;}
  close(){QueryState.dispose(this.db);this.storage.close();}
  private permission(operation:Config['operations'][number]) {
    if(!this.config.operations.includes(operation)) throw new MemoryError('OPERATION_DENIED','OPERATION_DENIED',{
      required_operation:operation,
      hint:operation==='verify'
        ? 'verification.status=verified requires separate verify permission. For ordinary user-authorized storage, basis=user_confirmation can accompany status=unverified. Do not silently change verification intent or elevate permissions.'
        : `This connection does not allow ${operation}. An operator must explicitly authorize the operation in its configuration; prompts and author_client do not grant permissions.`
    });
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
    if(event.connection_id!=='legacy:unknown' && event.connection_id!==this.config.connection_id)throw new MemoryError('REQUEST_ID_OWNER_MISMATCH');
    if(event.operation!==operation || event.request_hash!==hash(input)) throw new MemoryError('REQUEST_ID_REUSED');
    return JSON.parse(event.result);
  }
  private receipt(request_id:string,operation:string,input:unknown,project:string|null,scope:string,result:unknown) {
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)').run(request_id,operation,hash(input),project,scope,JSON.stringify(result),now(),this.config.connection_id);
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
    if(!(await stat(path)).isDirectory())throw new MemoryError('PROJECT_NOT_DIRECTORY');
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
    this.permission('recall');
    const absolute=await realpath(path);
    const matches=(this.db.prepare('SELECT * FROM projects').all() as any[]).filter(p=>this.config.all_projects || this.config.allowed_projects.includes(p.id)).flatMap(p=>JSON.parse(p.aliases).filter((a:string)=>absolute===a || absolute.startsWith(a+'/')).map((a:string)=>({project_id:p.id,alias:a})));
    matches.sort((a,b)=>b.alias.length-a.alias.length);
    return matches[0]??{project_id:null};
  }
  private dependencies(record:MemoryRecord,target?:string,allowStale=false) {
    for(const dep of record.derived_from) {
      const parent=this.find(dep.memory_id);
      const evidence:MemoryRecord=JSON.parse(parent.body);
      if(!allowStale && (parent.status!=='active' || parent.revision!==dep.revision ||
        (evidence.lifecycle??'current')!=='current' || !coversEffectiveTime(evidence.valid_time,now()) ||
        applicability(evidence.valid_for,{})==='excluded'))throw new MemoryError('DEPENDENCY_STALE');
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
  private isRevoked(id:string,importKey:string|undefined,hashes:string[],sources:MemoryRecord['sources']=[]) {
    const sourceHashes=sources.flatMap(s=>s.source_hash?[s.source_hash]:[]);
    const keys=JSON.stringify([...hashes,...sourceHashes]);
    return this.db.prepare(`SELECT 1 FROM tombstones WHERE id=? OR import_key=? OR content_hash IN (SELECT value FROM json_each(?))
      UNION ALL SELECT 1 FROM revoked_version_hashes WHERE content_hash IN (SELECT value FROM json_each(?))
      UNION ALL SELECT 1 FROM revoked_aliases WHERE kind='import_key' AND value=?
      UNION ALL SELECT 1 FROM revoked_aliases WHERE kind='source_hash' AND value IN (SELECT value FROM json_each(?)) LIMIT 1`)
      .get(id,importKey??null,keys,keys,importKey??null,JSON.stringify(sourceHashes))!==undefined;
  }
  private consolidationPackage(raw:unknown) {
    const input=consolidationPreviewSchema.parse(raw);
    this.scope(input.project_id,input.scope);
    return previewConsolidation(this.db,input,(id,record,digest)=>this.isRevoked(id,record.import_key,[digest],record.sources));
  }
  consolidate(raw:unknown) {
    this.permission('manage');
    this.db.exec('BEGIN');
    try { return this.consolidationPackage(raw); }
    finally { this.db.exec('ROLLBACK'); }
  }
  private validateConsolidation(record:MemoryRecord,plan?:TransitionPlan) {
    if(!record.consolidation)return;
    if(plan?.transition&&plan.transition!=='new')throw new MemoryError('CONSOLIDATION_TRANSITION');
    const {expires_at,...context}=record.valid_for;
    const report=this.consolidationPackage({project_id:record.project_id,scope:record.scope,title:record.title,
      claim:record.content,kind:record.kind,context,evidence:record.consolidation});
    const candidate=report.candidate;
    if(!candidate)throw new MemoryError('CONSOLIDATION_INSUFFICIENT');
    if(report.status==='conflict'&&record.lifecycle!=='quarantined')throw new MemoryError('CONSOLIDATION_CONFLICT');
    if(record.verification.status!=='unverified'||record.verification.basis!==candidate.verification.basis)
      throw new MemoryError('CONSOLIDATION_VERIFICATION');
    if(record.memory_form!==candidate.memory_form||hash(record.derived_from)!==hash(candidate.derived_from)||
       hash(record.sources)!==hash(candidate.sources)||hash(record.valid_for)!==hash(candidate.valid_for)||
       hash(record.valid_time??null)!==hash(('valid_time' in candidate?candidate.valid_time:null)??null))
      throw new MemoryError('CONSOLIDATION_EVIDENCE_CHANGED');
  }
  private transitionTargets(record:MemoryRecord,plan:TransitionPlan|undefined,source?:string) {
    const targets=new Map<string,Row>();
    for(const ref of plan?.expected_refs??[]) {
      if(ref.memory_id===source)throw new MemoryError('RELATION_SELF');
      const row=this.find(ref.memory_id);
      if(row.revision!==ref.revision || row.status!=='active')throw new MemoryError('VERSION_CONFLICT');
      if(row.scope!==record.scope || row.project_id!==record.project_id)throw new MemoryError('RELATION_SCOPE');
      const previous:MemoryRecord=JSON.parse(row.body);
      validateTransition(record,previous,plan?.transition);
      if(plan?.transition==='supersede' && previous.verification.status==='verified')this.permission('verify');
      targets.set(row.id,row);
    }
    const seen=new Set<string>();
    for(const relation of plan?.relations??[]) {
      const target=targets.get(relation.target_id);
      if(!target)throw new MemoryError('RELATION_REVISION_REQUIRED');
      const key=relation.target_id+':'+relation.type;
      if(seen.has(key) || plan?.transition==='reinforce' && relation.type==='supports' ||
        plan?.transition==='branch' && relation.type==='context_variant')throw new MemoryError('RELATION_DUPLICATE');
      seen.add(key);
      const evidence={...record,sources:relation.sources};
      this.sourceCheck(evidence);
      if(this.isRevoked('',undefined,[],relation.sources))throw new MemoryError('REVOKED_IMPORT');
      if(relation.type==='supports' || relation.type==='context_variant')
        validateTransition(evidence,JSON.parse(target.body),relation.type==='supports'?'reinforce':'branch');
    }
    return targets;
  }
  private readTransition(id:string) {
    const row=this.db.prepare('SELECT plan FROM proposal_transitions WHERE proposal_id=?').get(id);
    return row?String(row.plan):null;
  }
  async propose(raw:unknown,importTarget?:{id:string;revision:number}) {
    this.permission('propose');
    if(importTarget)this.permission('manage');
    const input=proposeSchema.parse(raw),record=input.record;
    const fingerprint={...input,record:{...record}};
    const plan:TransitionPlan|undefined=input.transition||input.expected_refs||input.relations
      ? {transition:input.transition,expected_refs:input.expected_refs,relations:input.relations}:undefined;
    this.scope(record.project_id,record.scope); this.sourceCheck(record);
    return this.storage.transaction(()=>{
      const retry=this.event(input.request_id,'propose',fingerprint); if(retry)return retry;
      if(input.target_id) {
        const target=this.find(input.target_id);
        if(target.status!=='active' || target.revision!==input.expected_revision)throw new MemoryError('VERSION_CONFLICT');
        if(target.scope!==record.scope || target.project_id!==record.project_id)throw new MemoryError('SCOPE_IMMUTABLE');
        const previous:MemoryRecord=JSON.parse(target.body);
        const supplied=(raw as any).record;
        for(const key of ['tags','valid_for','derived_from','import_key','memory_form','episode','valid_time','decision_state','lifecycle','subject_id','context_key','consolidation'] as const) {
          if(!Object.hasOwn(supplied,key) && previous[key]!==undefined)(record as any)[key]=previous[key];
        }
        if(record.consolidation&&!previous.consolidation)throw new MemoryError('CONSOLIDATION_REQUIRES_NEW_RECORD');
      }
      if(record.verification.status==='verified'){
        this.permission('verify');
        if(['source_claim','model_inference'].includes(record.verification.basis) || !record.verification.evidence)throw new MemoryError('VERIFICATION_EVIDENCE_REQUIRED');
      }
      const {reviewer,reviewed_at,...verification}=record.verification;
      record.verification=verification.status==='unverified'?verification:{...verification,reviewer:this.config.connection_id,reviewed_at:now()};
      if(plan?.transition==='quarantine')record.lifecycle='quarantined';
      this.transitionTargets(record,plan,input.target_id);
      this.validateConsolidation(record,plan);
      this.dependencies(record,input.target_id);
      if(this.isRevoked('',record.import_key,[recordHash(record)],record.sources))throw new MemoryError('REVOKED_IMPORT');
      if(record.import_key) {
        const duplicate=this.db.prepare('SELECT id,revision,project_id,scope FROM memories WHERE import_key=?').get(record.import_key) as any;
        if(duplicate && duplicate.id!==input.target_id)throw new MemoryError('IMPORT_ALREADY_EXISTS');
      }
      const similarQuery=ftsQuery(record.title+' '+record.content);
      const candidates=similarQuery?this.db.prepare("SELECT m.id,m.revision,m.body FROM memories_fts f JOIN memories m ON m.id=f.memory_id WHERE memories_fts MATCH ? AND m.status='active' AND m.scope=? AND m.project_id IS ? ORDER BY bm25(memories_fts) LIMIT 20").all(similarQuery,record.scope,record.project_id) as any[]:[];
      const words=new Set(terms(record.title+' '+record.content));
      const similar=candidates.map(x=>({memory_id:x.id,revision:x.revision,overlap:terms(JSON.parse(x.body).title+' '+JSON.parse(x.body).content).filter(w=>words.has(w)).length})).filter(x=>x.overlap>=3).sort((a,b)=>b.overlap-a.overlap).slice(0,5);
      const id=randomUUID();
      this.db.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?,?,?)').run(id,record.project_id,record.scope,JSON.stringify(record),input.target_id??null,input.expected_revision??0,'pending',now(),this.config.connection_id);
      if(plan)this.db.prepare('INSERT INTO proposal_transitions VALUES(?,?)').run(id,JSON.stringify(plan));
      if(importTarget)this.db.prepare('INSERT INTO import_targets VALUES(?,?,?)').run(id,importTarget.id,importTarget.revision);
      const result={proposal_id:id,expected_revision:input.expected_revision??0,similar_candidates:similar,missing_fields:[],
        ...(plan&&{planned_transition:{transition:plan.transition,expected_refs:plan.expected_refs,
          relations:plan.relations?.map(({type,target_id})=>({type,target_id}))}}),
        warning:'Similarity does not establish contradiction or permission to merge.'};
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
  private erasureTree(id:string) {
    return this.db.prepare(`WITH RECURSIVE children(id) AS (
      VALUES(?) UNION SELECT d.child_id FROM dependencies d JOIN children c ON d.parent_id=c.id
      UNION SELECT d.child_id FROM version_dependencies d JOIN children c ON d.parent_id=c.id
      UNION SELECT copy.memory_id FROM children c JOIN memory_versions v ON v.memory_id=c.id
        JOIN memory_versions copy ON copy.content_hash=v.content_hash
    ) SELECT id FROM children`).all(id).map(row=>String(row.id));
  }
  private invalidate(ids:string[],erase:boolean) {
    for(const id of ids) {
      this.deleteIndexes(id);
      if(erase) {
        const row=this.db.prepare('SELECT * FROM memories WHERE id=?').get(id) as Row|undefined;
        if(row) {
          this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES(?,?,?,?,?,?,?)').run(id,row.project_id,row.scope,row.revision,row.import_key,row.content_hash,now());
          revokeVersions(this.db,id);
          this.db.prepare('DELETE FROM memories WHERE id=?').run(id);
        }
        this.db.prepare('DELETE FROM dependencies WHERE child_id=? OR parent_id=?').run(id,id);
      } else this.db.prepare("UPDATE memories SET status='invalidated' WHERE id=?").run(id);
    }
    for(const p of this.db.prepare(`SELECT p.id,p.target_id,p.body,t.plan,i.memory_id import_target FROM proposals p
      LEFT JOIN proposal_transitions t ON t.proposal_id=p.id LEFT JOIN import_targets i ON i.proposal_id=p.id
      WHERE p.status='pending'`).all() as any[]) {
      const r:MemoryRecord=JSON.parse(p.body);
      const plan:TransitionPlan|undefined=p.plan?JSON.parse(p.plan):undefined;
      if(ids.includes(p.target_id) || ids.includes(p.import_target) || r.derived_from.some(d=>ids.includes(d.memory_id)) ||
        plan?.expected_refs?.some(ref=>ids.includes(ref.memory_id)) ||
        (erase&&this.isRevoked('',r.import_key,[recordHash(r)],[...r.sources,...(plan?.relations??[]).flatMap(edge=>edge.sources)]))) {
        this.db.prepare("UPDATE proposals SET body=NULL,status='invalidated' WHERE id=?").run(p.id);
        this.db.prepare('DELETE FROM proposal_transitions WHERE proposal_id=?').run(p.id);
        this.db.prepare('DELETE FROM import_targets WHERE proposal_id=?').run(p.id);
      }
    }
  }
  private supersede(target:Row,cutoff:string) {
    const previous=supersededRecord(JSON.parse(target.body),cutoff);
    const revision=target.revision+1;
    const changed=this.db.prepare("UPDATE memories SET body=?,revision=?,verified_at=?,content_hash=?,written_by=? WHERE id=? AND revision=? AND status='active'")
      .run(JSON.stringify(previous),revision,now(),recordHash(previous),this.config.connection_id,target.id,target.revision);
    if(Number(changed.changes)!==1)throw new MemoryError('VERSION_CONFLICT');
    this.db.prepare('UPDATE memory_chunks SET revision=? WHERE memory_id=? AND revision=?').run(revision,target.id,target.revision);
    this.invalidate(this.descendants(target.id),false);
  }
  private writeRelations(id:string,revision:number,record:MemoryRecord,plan:TransitionPlan,targets:Map<string,Row>) {
    const generatedType=plan.transition==='supersede'?'supersedes':plan.transition==='branch'?'context_variant':plan.transition==='reinforce'?'supports':undefined;
    const relations=generatedType
      ? [...targets.keys()].map(target_id=>({target_id,type:generatedType,sources:record.sources}))
      : [];
    const insert=this.db.prepare('INSERT INTO memory_relations VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    return [...relations,...(plan.relations??[])].map(({target_id,type,sources})=>{
      const relationId=randomUUID();
      const targetRevision=targets.get(target_id)!.revision+(plan.transition==='supersede'?1:0);
      insert.run(relationId,1,id,revision,target_id,targetRevision,type,record.project_id,record.scope,JSON.stringify(sources),now());
      return {id:relationId,revision:1,type,from:{memory_id:id,revision},to:{memory_id:target_id,revision:targetRevision}};
    });
  }
  async commit(raw:unknown) {
    this.permission('commit'); const input=commitSchema.parse(raw);
    const retry=this.event(input.request_id,'commit',input); if(retry)return retry;
    const proposal=this.db.prepare('SELECT * FROM proposals WHERE id=?').get(input.proposal_id) as any;
    if(!proposal)throw new MemoryError('PROPOSAL_NOT_FOUND');
    this.scope(proposal.project_id,proposal.scope);
    if(proposal.status!=='pending')throw new MemoryError('PROPOSAL_NOT_PENDING');
    if(proposal.expected_revision!==input.expected_revision)throw new MemoryError('VERSION_CONFLICT');
    const record:MemoryRecord=JSON.parse(proposal.body); if(record.verification.status==='verified')this.permission('verify'); this.sourceCheck(record);this.dependencies(record,proposal.target_id);
    const storedPlan=this.readTransition(proposal.id);
    const plan:TransitionPlan|undefined=storedPlan?JSON.parse(storedPlan):undefined;
    this.validateConsolidation(record,plan);
    this.transitionTargets(record,plan,proposal.target_id);
    let chunks,profile;
    try { profile=await this.encoder.profile(); chunks=await this.encoder.chunks(record.title,record.content); }
    catch(error) { if(error instanceof MemoryError && error.code==='QUERY_TOO_LONG')throw error;throw new MemoryError('EMBEDDING_UNAVAILABLE'); }
    this.checkpoint('after_embedding');
    return this.storage.transaction(()=>{
      this.checkpoint('begin');
      const repeated=this.event(input.request_id,'commit',input);if(repeated)return repeated;
      const current=this.db.prepare('SELECT * FROM proposals WHERE id=?').get(input.proposal_id) as any;
      if(!current || current.status!=='pending' || current.body!==proposal.body || this.readTransition(proposal.id)!==storedPlan)throw new MemoryError('PROPOSAL_NOT_PENDING');
      this.scope(record.project_id,record.scope); this.dependencies(record,proposal.target_id);
      this.validateConsolidation(record,plan);
      const targets=this.transitionTargets(record,plan,proposal.target_id);
      const otherProfile=this.db.prepare("SELECT profile_id FROM memories WHERE status='active' AND profile_id!=? LIMIT 1").get(profile.id);
      if(otherProfile)throw new MemoryError('INDEX_PROFILE_MISMATCH');
      const imported=this.db.prepare('SELECT * FROM import_targets WHERE proposal_id=?').get(proposal.id) as any;
      const id=proposal.target_id??imported?.memory_id??randomUUID();
      const old=proposal.target_id?this.find(id):null;
      if(old && (old.revision!==input.expected_revision || old.status!=='active'))throw new MemoryError('VERSION_CONFLICT');
      const contentHash=recordHash(record);
      if(this.isRevoked(id,record.import_key,[contentHash],record.sources))throw new MemoryError('REVOKED_IMPORT');
      this.db.prepare('INSERT OR IGNORE INTO embedding_profiles VALUES(?,?)').run(profile.id,JSON.stringify(profile.manifest));
      this.checkpoint('profile');
      if(!old && this.db.prepare('SELECT id FROM memories WHERE id=?').get(id))throw new MemoryError('IMPORT_ID_CONFLICT');
      const revision=old?old.revision+1:imported?.revision??1;
      if(old) {this.invalidate(this.descendants(id),false);this.deleteIndexes(id);}
      if(old&&plan)this.transitionTargets(record,plan,id);
      if(plan?.transition==='supersede') {
        for(const target of targets.values())this.supersede(target,record.valid_time!.valid_from!);
        this.dependencies(record);
        this.checkpoint('transition:predecessors');
      }
      this.checkpoint('index_delete');
      this.db.prepare(`INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,revision=excluded.revision,status=excluded.status,verified_at=excluded.verified_at,profile_id=excluded.profile_id,content_hash=excluded.content_hash,import_key=excluded.import_key,written_by=excluded.written_by`).run(id,record.project_id,record.scope,JSON.stringify(record),revision,'active',old?.created_at??now(),now(),profile.id,contentHash,record.import_key??null,this.config.connection_id);
      this.checkpoint('row');
      this.db.prepare('DELETE FROM dependencies WHERE child_id=?').run(id);
      for(const dep of record.derived_from)this.db.prepare('INSERT INTO dependencies VALUES(?,?,?)').run(id,dep.memory_id,dep.revision);
      this.checkpoint('dependencies');
      this.indexChunks(id,revision,profile.id,record,chunks);
      this.checkpoint('chunks');
      this.db.prepare('INSERT INTO memories_fts VALUES(?,?)').run(id,terms(record.title+' '+record.content+' '+record.tags.join(' ')).join(' '));
      this.checkpoint('fts');
      const relations=plan?this.writeRelations(id,revision,record,plan,targets):undefined;
      if(relations?.length)this.db.exec("UPDATE meta SET value=value+1 WHERE key='graph_epoch'");
      this.db.prepare("UPDATE proposals SET status='committed',body=NULL WHERE id=?").run(proposal.id);
      if(plan)this.db.prepare('DELETE FROM proposal_transitions WHERE proposal_id=?').run(proposal.id);
      this.checkpoint('proposal');
      const result={memory_id:id,revision,generation:this.storage.advance(),embedding_profile_id:profile.id,written_by:this.config.connection_id,
        ...(relations?.length&&{relations})};
      this.receipt(input.request_id,'commit',input,record.project_id,record.scope,result);this.checkpoint('receipt');return result;
    });
  }
  private indexChunks(id:string,revision:number,profile:string,record:MemoryRecord,chunks:Chunk[]) {
    for(const c of chunks) {
      const result=this.db.prepare('INSERT INTO memory_chunks(memory_id,revision,start,end,tokens,text,profile_id) VALUES(?,?,?,?,?,?,?)').run(id,revision,c.start,c.end,c.tokens,c.text,profile);
      this.db.prepare('INSERT INTO memory_vec VALUES(?,?,?)').run(BigInt(result.lastInsertRowid),blob(c.vector),record.project_id??'global');
      indexChunk(this.db,{id:Number(result.lastInsertRowid),memory_id:id,text:c.text},record.title,record.tags);
    }
  }
  async recall(raw:unknown,mode:'hybrid'|'lexical'|'vector'='hybrid') {
    this.permission('recall');const input=recallSchema.parse(raw);
    if(input.exact_only && (!input.query || identifiers(input.query).length===0))throw new MemoryError('EXACT_IDENTIFIER_REQUIRED');
    if(input.project_id)this.scope(input.project_id,'project');
    if(input.include_global??(!input.project_id&&this.config.allow_global))this.scope(null,'global');
    return retrieve({db:this.db,config:this.config,encoder:this.encoder,generation:()=>this.storage.generation(),checkpoint:this.checkpoint},input,mode);
  }
  async feedback(raw:unknown) {
    this.permission('feedback');this.permission('recall');
    const input=feedbackSchema.parse(raw),cache=QueryState.open(this.db,this.config);
    const receipt=cache.receipt(input.page_receipt);
    return this.storage.transaction(()=>{
      const retry=this.event(input.request_id,'feedback',input);
      if(retry)return retry;
      if(!receipt || receipt.authority!==authority(this.config,this.db))throw new MemoryError('FEEDBACK_RECEIPT_UNAVAILABLE');
      if(Number(receipt.expires)<=Date.now())throw new MemoryError('FEEDBACK_RECEIPT_EXPIRED');
      const used=JSON.parse(String(receipt.used)) as typeof input.used;
      const context=recallSchema.parse(JSON.parse(String(receipt.input))).context;
      const endpoints=input.used.map(ref=>{
        if(!used.some(saved=>saved.memory_id===ref.memory_id&&saved.revision===ref.revision))
          throw new MemoryError('FEEDBACK_EVIDENCE_NOT_RETURNED');
        const row=this.db.prepare('SELECT * FROM memories WHERE id=?').get(ref.memory_id) as Row|undefined;
        if(!row)throw new MemoryError('FEEDBACK_EVIDENCE_STALE');
        this.scope(row.project_id,row.scope);
        const record=JSON.parse(row.body) as MemoryRecord;
        if(row.status!=='active' || row.revision!==ref.revision ||
          (record.lifecycle??'current')!=='current' || !coversEffectiveTime(record.valid_time,now()) ||
          applicability(record.valid_for,context)!=='current' || this.isRevoked(row.id,row.import_key??undefined,[row.content_hash]))
          throw new MemoryError('FEEDBACK_EVIDENCE_STALE');
        return row;
      });
      const scope=endpoints[0];
      if(endpoints.some(row=>row.scope!==scope.scope||row.project_id!==scope.project_id))throw new MemoryError('FEEDBACK_SCOPE');
      const result=recordFeedback(this.db,this.config,input,scope);
      if(result.recorded)this.receipt(input.request_id,'feedback',input,scope.project_id,scope.scope,result);
      this.checkpoint('feedback:queued');
      return result;
    });
  }
  projectFeedback(limit=100,rebuild=false) {
    this.permission('manage');
    if(!this.config.all_projects||!this.config.allow_global)throw new MemoryError('MAINTENANCE_SCOPE_DENIED');
    if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new MemoryError('PROJECTION_BATCH_INVALID');
    return this.storage.transaction(()=>{
      const result=projectFeedback(this.db,limit,rebuild);
      this.checkpoint('feedback:projected');
      return result;
    });
  }
  async forget(raw:unknown) {
    this.permission('forget');const input=forgetSchema.parse(raw);
    const result=this.storage.transaction(()=>{
      const retry=this.event(input.request_id,'forget',input);if(retry)return retry;
      const row=this.find(input.memory_id);
      if(row.revision!==input.expected_revision)throw new MemoryError('VERSION_CONFLICT');
      const all=this.erasureTree(row.id);
      this.invalidate(all,true);
      this.db.prepare("INSERT OR REPLACE INTO meta VALUES('revocations_pending',1)").run();
      for(const entry of this.db.prepare("SELECT * FROM exports WHERE status!='removed'").all() as any[]) {
        if(JSON.parse(entry.ids).some((id:string)=>all.includes(id)))this.db.prepare("UPDATE exports SET status='pending_cleanup' WHERE id=?").run(entry.id);
      }
      const result={memory_id:row.id,forgotten:true,derived_erased:all.length-1,generation:this.storage.advance(),managed_copies:'pending_check',outside_control:['prior chat/tool context','unmanaged backups','OS snapshots','SSD forensic erasure']};
      this.receipt(input.request_id,'forget',input,row.project_id,row.scope,result);return result;
    });
    return {...result,maintenance:await this.maintain()};
  }
  cache(maintenance=false) {
    this.permission('manage');
    const cache=QueryState.open(this.db,this.config);
    try{if(maintenance){cache.begin();try{cache.cleanup();cache.commit();}catch(e){cache.rollback();throw e;}cache.checkpoint();}return cache.inspect();}finally{cache.close();}
  }
  async maintenance() {this.permission('manage');return {...await this.maintain(),query_cache:this.cache(true)};}
  private async maintain() {
    const errors:string[]=[];
    // Serialize filesystem maintenance with exporters/forgetters; no asynchronous gap.
    this.storage.transaction(()=>{
      for(const entry of this.db.prepare("SELECT * FROM exports WHERE status IN ('pending_cleanup','pending_write')").all() as any[]) {
        try {unlinkSync(entry.path);this.db.prepare("UPDATE exports SET status='removed' WHERE id=?").run(entry.id);}
        catch(e:any) {if(e.code==='ENOENT')this.db.prepare("UPDATE exports SET status='removed' WHERE id=?").run(entry.id);else errors.push('EXPORT_CLEANUP_PENDING');}
      }
      try{this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES('optimize'); INSERT INTO chunk_fts(chunk_fts) VALUES('optimize');");}catch{errors.push('FTS_CLEANUP_PENDING');}
      try {
        const root=dirname(this.config.database);mkdirSync(root,{recursive:true,mode:0o700});
        const tombstones=this.revocationRows();
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
      this.db.prepare("UPDATE proposals SET body=NULL,status='discarded' WHERE id=? AND status='pending'").run(id);
      this.db.prepare('DELETE FROM proposal_transitions WHERE proposal_id=?').run(id);
      return {discarded:id};
    });
  }
  inspect() {
    this.permission('manage');
    const projects=(this.db.prepare('SELECT * FROM projects').all() as any[]).filter(p=>this.config.all_projects || this.config.allowed_projects.includes(p.id));
    const counts=this.db.prepare("SELECT scope,project_id,status,count(*) AS count FROM memories GROUP BY scope,project_id,status").all().filter((r:any)=>(r.scope==='global'?this.config.allow_global:this.config.all_projects || this.config.allowed_projects.includes(r.project_id)));
    return {query_cache:this.cache(),schema:this.storage.schema(),generation:this.storage.generation(),projects,counts};
  }
  check() {
    this.permission('manage');
    const integrity=this.db.prepare('PRAGMA integrity_check').all();
    const orphan_chunks=this.db.prepare("SELECT count(*) AS n FROM memory_chunks c LEFT JOIN memories m ON m.id=c.memory_id WHERE m.id IS NULL OR m.status!='active' OR m.revision!=c.revision OR m.profile_id!=c.profile_id").get();
    const orphan_vectors=this.db.prepare('SELECT count(*) AS n FROM memory_vec v LEFT JOIN memory_chunks c ON c.id=v.chunk_id WHERE c.id IS NULL').get();
    const missing_vectors=this.db.prepare('SELECT count(*) AS n FROM memory_chunks c LEFT JOIN memory_vec v ON c.id=v.chunk_id WHERE v.chunk_id IS NULL').get();
    const unindexed=this.db.prepare("SELECT count(*) AS n FROM memories m WHERE status='active' AND (NOT EXISTS(SELECT 1 FROM memory_chunks c WHERE c.memory_id=m.id) OR NOT EXISTS(SELECT 1 FROM memories_fts f WHERE f.memory_id=m.id))").get();
    const search_mismatch=this.db.prepare(`SELECT count(*) n FROM memories m LEFT JOIN memory_search s ON s.memory_id=m.id
      WHERE s.memory_id IS NULL OR s.revision!=m.revision OR s.status!=m.status OR s.profile_id!=m.profile_id OR s.project_id IS NOT m.project_id OR s.scope!=m.scope OR s.metadata!=json_remove(m.body,'$.content')`).get();
    const missing_chunk_fts=this.db.prepare("SELECT count(*) n FROM memory_chunks c JOIN memories m ON m.id=c.memory_id WHERE m.status='active' AND NOT EXISTS(SELECT 1 FROM chunk_fts f WHERE f.chunk_id=c.id AND f.memory_id=c.memory_id)").get();
    const orphan_chunk_fts=this.db.prepare('SELECT count(*) n FROM chunk_fts f LEFT JOIN memory_chunks c ON c.id=f.chunk_id WHERE c.id IS NULL OR c.memory_id!=f.memory_id').get();
    const orphan_identifiers=this.db.prepare('SELECT count(*) n FROM chunk_identifiers i LEFT JOIN memory_chunks c ON c.id=i.chunk_id WHERE c.id IS NULL OR c.memory_id!=i.memory_id').get();
    const version_mismatch=this.db.prepare(`SELECT count(*) n FROM memories m LEFT JOIN memory_versions v ON v.memory_id=m.id AND v.revision=m.revision
      WHERE v.memory_id IS NULL OR v.body<>m.body OR v.content_hash<>m.content_hash OR v.written_by<>m.written_by OR v.recorded_at<>m.verified_at`).get();
    const invalid_versions=this.db.prepare(`SELECT count(*) n FROM memory_versions v LEFT JOIN memories m ON m.id=v.memory_id
      WHERE m.id IS NULL OR v.revision>m.revision OR EXISTS(SELECT 1 FROM tombstones t WHERE t.id=v.memory_id)`).get();
    const version_gaps=this.db.prepare(`SELECT count(*) n FROM (
      SELECT memory_id FROM memory_versions GROUP BY memory_id HAVING count(*)<>max(revision)-min(revision)+1)`).get();
    const missing_version_dependencies=this.db.prepare(`SELECT count(*) n FROM (
      SELECT json_extract(d.value,'$.memory_id'),v.memory_id,v.revision FROM memory_versions v,json_each(v.body,'$.derived_from') d
      EXCEPT SELECT parent_id,child_id,child_revision FROM version_dependencies)`).get();
    const relation_scope_errors=this.db.prepare(`SELECT count(*) n FROM memory_relations e
      LEFT JOIN memories a ON a.id=e.from_id LEFT JOIN memories b ON b.id=e.to_id
      WHERE a.id IS NULL OR b.id IS NULL OR a.scope<>e.scope OR b.scope<>e.scope
        OR a.project_id IS NOT e.project_id OR b.project_id IS NOT e.project_id`).get();
    let version_hash_errors=0;
    for(const row of this.db.prepare('SELECT body,content_hash FROM memory_versions').iterate()) {
      try { if(recordHash(JSON.parse(String(row.body)))!==row.content_hash)version_hash_errors++; }
      catch { version_hash_errors++; }
    }
    return {integrity,orphan_chunks,orphan_vectors,missing_vectors,unindexed,search_mismatch,missing_chunk_fts,orphan_chunk_fts,orphan_identifiers,
      version_mismatch,invalid_versions,version_gaps,missing_version_dependencies,version_hash_errors:{n:version_hash_errors},relation_scope_errors};
  }
  private archivedVersions(id:string) {
    return this.db.prepare('SELECT revision,body,content_hash,recorded_at,profile_id,written_by FROM memory_versions WHERE memory_id=? ORDER BY revision').all(id);
  }
  async export(project_id:string,include_global=false,format:'json'|'markdown'|'versioned'='json') {
    this.permission('manage');this.scope(project_id,'project');if(include_global)this.scope(null,'global');
    if(!['json','markdown','versioned'].includes(format))throw new MemoryError('EXPORT_FORMAT_INVALID');
    const id=randomUUID(),root=join(dirname(this.config.database),'exports');await mkdir(root,{recursive:true,mode:0o700});
    const path=join(root,id+(format==='markdown'?'.md':'.json'));
    // Register the path durably BEFORE it can contain a body. Crash leftovers stay managed.
    this.storage.transaction(()=>this.db.prepare('INSERT INTO exports VALUES(?,?,?,?)').run(id,path,'[]','pending_write'));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows=this.db.prepare(`SELECT * FROM memories WHERE ${format==='versioned'?"status IN ('active','invalidated')":"status='active'"} AND (project_id=? OR (?=1 AND scope='global')) ORDER BY id`).all(project_id,Number(include_global)) as Row[];
      const common={generation:this.storage.generation(),export_id:id,revocations:this.revocationRows(project_id,include_global)};
      let content:string;
      if(format==='versioned') {
        const records=rows.map(r=>({id:r.id,status:r.status,created_at:r.created_at,versions:this.archivedVersions(r.id)}));
        content=JSON.stringify({format:VERSION_ARCHIVE,...common,records},null,2);
      } else {
        const memories=rows.map(r=>({id:r.id,revision:r.revision,content_hash:r.content_hash,record:JSON.parse(r.body)}));
        content=format==='json'?JSON.stringify({schema:1,...common,memories},null,2):memories.map(m=>`# ${m.record.title}\n\nID: ${m.id}; revision: ${m.revision}\n\n${m.record.content}\n\n${m.record.sources.map((s:any)=>`${s.uri} — ${s.locator} (${s.revision_ref})`).join('\n')}\n`).join('\n');
      }
      const current=this.db.prepare('SELECT status FROM exports WHERE id=?').get(id) as any;
      if(current.status!=='pending_write')throw new MemoryError('EXPORT_CANCELLED');
      writeFileSync(path,content,{mode:0o600,flag:'wx'});
      this.db.prepare("UPDATE exports SET status='active',ids=? WHERE id=?").run(JSON.stringify(rows.map(r=>r.id)),id);
      this.db.exec('COMMIT');return {export_id:id,path,records:rows.length};
    }catch(error){this.db.exec('ROLLBACK');try{unlinkSync(path);}catch{}throw error;}
  }
  private archiveAction(entry:ReturnType<typeof parseArchive>[number]) {
    const latest=entry.latest.record;
    const current=this.db.prepare('SELECT * FROM memories WHERE id=?').get(entry.id) as Row|undefined;
    if(current)this.scope(current.project_id,current.scope);
    for(const {record,version} of entry.decoded) {
      this.scope(record.project_id,record.scope);
      this.sourceCheck(record);
      if(record.project_id!==latest.project_id || record.scope!==latest.scope)throw new MemoryError('SCOPE_IMMUTABLE');
      if(record.verification.status==='verified') {
        this.permission('verify');
        if(['source_claim','model_inference'].includes(record.verification.basis) || !record.verification.evidence)
          throw new MemoryError('VERIFICATION_EVIDENCE_REQUIRED');
      }
      if(this.isRevoked(entry.id,record.import_key,[version.content_hash],record.sources))return 'blocked_revoked';
    }
    if(current)return current.status===entry.status && current.created_at===entry.created_at &&
      hash(this.archivedVersions(entry.id))===hash(entry.versions)?'unchanged':'blocked_conflict';
    if(latest.import_key && this.db.prepare('SELECT 1 FROM memories WHERE import_key=?').get(latest.import_key))return 'blocked_conflict';
    return 'create';
  }
  previewArchive(raw:unknown) {
    this.permission('manage');
    return parseArchive(raw).map(entry=>({memory_id:entry.id,revision:entry.latest.version.revision,action:this.archiveAction(entry)}));
  }
  async restoreArchive(raw:unknown) {
    this.permission('manage');this.permission('propose');this.permission('commit');
    if(!this.revocationsChecked)throw new MemoryError('LATEST_REVOCATIONS_REQUIRED');
    const entries=parseArchive(raw), generation=this.storage.generation();
    const pending:typeof entries=[];
    for(const entry of entries) {
      const action=this.archiveAction(entry);
      if(action.startsWith('blocked'))throw new MemoryError('ARCHIVE_'+action.toUpperCase());
      if(action==='create')pending.push(entry);
    }
    if(!pending.length)return {restored:0,unchanged:entries.length,generation};
    const profile=await this.encoder.profile();
    const encoded=new Map<string,Chunk[]>();
    for(const entry of pending)if(entry.status==='active')
      encoded.set(entry.id,await this.encoder.chunks(entry.latest.record.title,entry.latest.record.content));
    return this.storage.transaction(()=>{
      if(this.storage.generation()!==generation)throw new MemoryError('VERSION_CONFLICT');
      if(this.db.prepare("SELECT 1 FROM memories WHERE status='active' AND profile_id<>? LIMIT 1").get(profile.id))
        throw new MemoryError('INDEX_PROFILE_MISMATCH');
      this.db.prepare('INSERT OR IGNORE INTO embedding_profiles VALUES(?,?)').run(profile.id,JSON.stringify(profile.manifest));
      for(const entry of pending) {
        const action=this.archiveAction(entry);
        if(action!=='create')throw new MemoryError('ARCHIVE_'+action.toUpperCase());
        const {record,version}=entry.latest;
        this.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(entry.id,record.project_id,record.scope,
          version.body,version.revision,entry.status,entry.created_at,version.recorded_at,profile.id,version.content_hash,
          record.import_key??null,version.written_by);
        this.db.prepare('DELETE FROM memory_versions WHERE memory_id=?').run(entry.id);
        const insert=this.db.prepare('INSERT INTO memory_versions VALUES(?,?,?,?,?,?,?)');
        for(const v of entry.versions)insert.run(entry.id,v.revision,v.body,v.content_hash,v.recorded_at,v.profile_id,v.written_by);
        for(const d of record.derived_from)this.db.prepare('INSERT INTO dependencies VALUES(?,?,?)').run(entry.id,d.memory_id,d.revision);
        const chunks=encoded.get(entry.id);
        if(chunks) {
          this.indexChunks(entry.id,version.revision,profile.id,record,chunks);
          this.db.prepare('INSERT INTO memories_fts VALUES(?,?)').run(entry.id,terms(record.title+' '+record.content+' '+record.tags.join(' ')).join(' '));
        }
      }
      for(const entry of pending) {
        this.dependencies(entry.latest.record,entry.id,entry.status==='invalidated');
        if(entry.status==='active')this.validateConsolidation(entry.latest.record);
      }
      return {restored:pending.length,unchanged:entries.length-pending.length,generation:this.storage.advance()};
    });
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
        this.indexChunks(row.id,row.revision,profile.id,body,chunks);
        this.db.prepare('INSERT INTO memories_fts VALUES(?,?)').run(row.id,terms(body.title+' '+body.content+' '+body.tags.join(' ')).join(' '));
      }
      return {reindexed:rows.length,profile_id:profile.id,generation:this.storage.advance()};
    });
  }
  previewImport(entry:any) {
    this.permission('manage');const original=entry.record??entry,parsed=recordSchema.parse(original);
    const {reviewer,reviewed_at,...verification}=parsed.verification;
    const record={...parsed,verification:{...verification,status:'unverified' as const,basis:'source_claim' as const}};
    this.scope(record.project_id,record.scope);this.sourceCheck(record);
    const import_key=record.import_key??'source:'+hash(record.sources.map(s=>({uri:s.uri,locator:s.locator})));
    const normalized={...record,import_key};
    const existing=this.db.prepare('SELECT * FROM memories WHERE import_key=? OR id=?').get(import_key,entry.id??'') as Row|undefined;
    if(existing)this.scope(existing.project_id,existing.scope);
    const revoked=this.isRevoked(entry.id??'',import_key,[hash(original),recordHash(parsed),recordHash(normalized),entry.content_hash??''],record.sources);
    let action=revoked?'blocked_revoked':existing?(existing.content_hash===recordHash(normalized)?'unchanged':'update'):'create';
    if(existing && (existing.project_id!==record.project_id || existing.scope!==record.scope))action='blocked_scope';
    if(existing && entry.revision && existing.revision!==entry.revision && action!=='unchanged')action='blocked_revision';
    return {record:normalized,existing_id:existing?.id,existing_revision:existing?.revision,import_key,source_hash:hash(record.sources),action};
  }
  async importEntry(entry:any) {
    const preview=this.previewImport(entry);
    if(!this.revocationsChecked)throw new MemoryError('LATEST_REVOCATIONS_REQUIRED');
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
    this.permission('manage');this.revocationsChecked=false;
    const result=this.storage.transaction(()=>{
      const erase=new Set<string>();
      for(const t of entries) {
        if(!t || !['project','global'].includes(t.scope))throw new MemoryError('REVOCATION_INVALID');
        this.scope(t.project_id,t.scope);
        const validHash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
        const versionHashes=t.version_hashes??[];
        const sourceHashes=t.source_hashes??[],importKeys=t.import_keys??[];
        if(typeof t.id!=='string' || !Number.isSafeInteger(t.revision) || !validHash(t.content_hash) ||
          !Array.isArray(versionHashes) || !versionHashes.every(validHash) || !Array.isArray(sourceHashes) || !sourceHashes.every(validHash) ||
          !Array.isArray(importKeys) || ![...importKeys,...(t.import_key==null?[]:[t.import_key])].every(key=>typeof key==='string'&&key.length>0&&key.length<=256))
          throw new MemoryError('REVOCATION_INVALID');
        const current=this.db.prepare('SELECT project_id,scope FROM memories WHERE id=? UNION ALL SELECT project_id,scope FROM tombstones WHERE id=? LIMIT 1').get(t.id,t.id) as any;
        if(current){this.scope(current.project_id,current.scope);if(current.project_id!==t.project_id||current.scope!==t.scope)throw new MemoryError('REVOCATION_SCOPE_MISMATCH');}
        this.db.prepare('INSERT OR IGNORE INTO tombstones VALUES(?,?,?,?,?,?,?)').run(t.id,t.project_id,t.scope,t.revision,t.import_key??null,t.content_hash,t.forgotten_at??now());
        const hashes=[...new Set([t.content_hash,...versionHashes])];
        for(const hash of hashes)
          this.db.prepare('INSERT OR IGNORE INTO revoked_version_hashes VALUES(?,?)').run(t.id,hash);
        const alias=this.db.prepare('INSERT OR IGNORE INTO revoked_aliases VALUES(?,?,?)');
        for(const value of new Set([...importKeys,...(t.import_key==null?[]:[t.import_key])]))alias.run(t.id,'import_key',value);
        for(const value of sourceHashes)alias.run(t.id,'source_hash',value);
        for(const id of this.erasureTree(t.id))erase.add(id);
        const copies=this.db.prepare(`SELECT DISTINCT v.memory_id FROM memory_versions v JOIN memories m ON m.id=v.memory_id
          WHERE m.scope=? AND m.project_id IS ? AND v.content_hash IN (SELECT value FROM json_each(?))`).all(t.scope,t.project_id,JSON.stringify(hashes));
        for(const copy of copies)for(const id of this.erasureTree(String(copy.memory_id)))erase.add(id);
      }
      if(erase.size)this.invalidate([...erase],true);
      for(const entry of this.db.prepare("SELECT id,ids FROM exports WHERE status!='removed'").all() as {id:string;ids:string}[]) {
        if((JSON.parse(entry.ids) as string[]).some(id=>erase.has(id)||this.db.prepare('SELECT 1 FROM tombstones WHERE id=?').get(id)))
          this.db.prepare("UPDATE exports SET status='pending_cleanup' WHERE id=?").run(entry.id);
      }
      this.db.prepare("INSERT OR REPLACE INTO meta VALUES('revocations_pending',1)").run();
      return {revocations_applied:entries.length,generation:this.storage.advance()};
    });
    const maintenance=await this.maintain();
    if(!maintenance.revocations_synced)throw new MemoryError('REVOCATIONS_UNSYNCED_RESTORE_FORBIDDEN');
    this.revocationsChecked=true;return result;
  }
  private revocationRows(project?:string,includeGlobal=false) {
    const rows=project
      ? this.db.prepare("SELECT * FROM tombstones WHERE project_id=? OR (?=1 AND scope='global') ORDER BY id").all(project,Number(includeGlobal))
      : this.db.prepare('SELECT * FROM tombstones ORDER BY id').all();
    const hashes=this.db.prepare('SELECT content_hash FROM revoked_version_hashes WHERE memory_id=? ORDER BY content_hash');
    const aliases=this.db.prepare('SELECT value FROM revoked_aliases WHERE memory_id=? AND kind=? ORDER BY value');
    return rows.map(row=> {
      const version_hashes=hashes.all(String(row.id)).map(r=>r.content_hash);
      const import_keys=aliases.all(String(row.id),'import_key').map(r=>r.value);
      const source_hashes=aliases.all(String(row.id),'source_hash').map(r=>r.value);
      return {...row,...(version_hashes.length&&{version_hashes}),...(import_keys.length&&{import_keys}),...(source_hashes.length&&{source_hashes})};
    });
  }
}
