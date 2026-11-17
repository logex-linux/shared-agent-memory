import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink, realpath,stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { writeFileSync, renameSync, unlinkSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { Storage } from '../storage/database.js';
import { indexChunk } from '../retrieval/indexes.js';
import { QueryState, authority } from '../retrieval/state.js';
import { retrieve } from '../retrieval/recall.js';
import { startTaskOverride,taskExclusions } from '../retrieval/task-override.js';
import { packEvidence } from '../retrieval/context-pack.js';
import { BgeEncoder } from '../embedding/bge.js';
import { ftsQuery, terms, identifiers } from '../retrieval/lexical.js';
import { recordHash } from '../memory/versions.js';
import { parseArchive, VERSION_ARCHIVE, LEGACY_VERSION_ARCHIVE } from '../memory/archive.js';
import { coversEffectiveTime } from '../memory/temporal.js';
import { supersededRecord, validateTransition, type TransitionPlan } from '../memory/transitions.js';
import { projectFeedback, recordFeedback } from '../memory/feedback.js';
import { erasureTree, revokeVersions } from '../memory/erasure.js';
import { previewConsolidation } from '../memory/consolidation.js';
import { checkCurrentRule, checkDuplicate, sameMemoryMaterial } from '../memory/writes.js';
import { ADMISSION_POLICY,admissionDecision,admissionDigest,checkAdmission } from '../memory/admission.js';
import { browseCatalog,catalogRoute,explainVisibility } from '../memory/catalog.js';
import { validateSubjectAliases, type AnchoredClaim } from '../memory/subjects.js';
import { sourceStatus } from '../memory/source-status.js';
import { managedExports, ownershipAdvances, ownershipImpact, relatedProposals, sameOwnership } from '../memory/ownership.js';
import { appendAction, currentMaintenance, maintenancePath, parseMaintenance, prefixOf, readMaintenance, readRevocations,
  revocationSubset, revocationsPath, syncMaintenance, type MaintenanceLedger, type RecoveryAction } from '../memory/recovery.js';
import { cutoff, expires, pinned, pruneBody, retainedSourceKeys, versionCandidate } from '../memory/retention.js';
import { MemoryError, applicability, hash, stable, configSchema, proposeSchema, recallSchema, commitSchema, forgetSchema, feedbackSchema,
  recordSchema, consolidationPreviewSchema, forgetPreviewSchema, projectAliasesSchema, reassignSchema,retentionSchema,proposalRenewSchema,
  type Config, type Encoder, type MemoryRecord, type Chunk, type Ownership, type ProposeInput } from './contracts.js';
import { admissionSchema,browseSchema,classifySchema,contextPackSchema,inspectMemorySchema,taskOverrideSchema,type ViewScope } from './frontier-contracts.js';

type Row=Ownership&{id:string;body:string;revision:number;status:string;created_at:string;verified_at:string;profile_id:string;content_hash:string;import_key:string|null;written_by:string};
type Project={id:string;name:string;aliases:string};
const now=()=>new Date().toISOString();
const blob=(v:Float32Array)=>Buffer.from(v.buffer,v.byteOffset,v.byteLength);
const versionHead=(row:Row)=>({memory_id:row.id,revision:row.revision,content_hash:row.content_hash});
const transitionPlan=(input:ProposeInput):TransitionPlan|undefined=>input.transition||input.expected_refs||input.relations
  ? {transition:input.transition,expected_refs:input.expected_refs,relations:input.relations,version_evolution:input.version_evolution}:undefined;

export async function readConfig(path:string):Promise<Config> {
  const raw=JSON.parse(await readFile(path,'utf8'));
  return configSchema.parse({...raw,connection_id:raw.connection_id??'config:'+hash(await realpath(path)).slice(0,24)});
}
export class MemoryService {
  private revocationsChecked=false;
  private importMaintenance?:MaintenanceLedger;
  private recoveryMode=false;
  storage:Storage;
  encoder:Encoder;
  constructor(public config:Config,encoder?:Encoder,private checkpoint:(point:string)=>void=()=>{},stagingRecovery=false) {
    this.config=configSchema.parse(config);
    this.storage=new Storage(config.database,checkpoint);
    try {
      if(stagingRecovery)this.storage.transaction(()=>this.db.exec("UPDATE meta SET value=1 WHERE key='recovery_pending'"));
      else {
        if(this.db.prepare("SELECT value FROM meta WHERE key='recovery_pending'").get()?.value)
          throw new MemoryError('RECOVERY_RECONCILIATION_REQUIRED');
        if(this.config.maintenance_state&&this.storage.generation()>0) {
          const latest=readMaintenance(maintenancePath(this.config));
          if(!prefixOf(latest,currentMaintenance(this.db)) ||
            !revocationSubset(readRevocations(revocationsPath(this.config)),this.revocationRows()))
            throw new MemoryError('LATEST_RECOVERY_STATE_REQUIRED');
        }
      }
    }catch(error) {
      this.storage.close();
      throw error;
    }
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
    if(!this.recoveryMode&&this.db.prepare("SELECT value FROM meta WHERE key='recovery_pending'").get()?.value)
      throw new MemoryError('RECOVERY_RECONCILIATION_REQUIRED');
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
    const result=JSON.parse(event.result);
    const refs=new Set<string>([
      result.memory_id,...(result.records??[]).map((r:any)=>r.memory_id),
      ...(result.similar_candidates??[]).map((r:any)=>r.memory_id),
      ...(result.planned_transition?.expected_refs??[]).map((r:any)=>r.memory_id),
      ...(result.relations??[]).flatMap((r:any)=>[r.from.memory_id,r.to.memory_id])
    ].filter(Boolean));
    if(result.proposal_id) {
      const proposal=this.db.prepare('SELECT target_id FROM proposals WHERE id=?').get(result.proposal_id);
      if(proposal?.target_id)refs.add(String(proposal.target_id));
    }
    for(const id of refs) {
      const owner=this.currentOwner(id);
      if(owner)this.scope(owner.project_id,owner.scope);
    }
    return result;
  }
  private receipt(request_id:string,operation:string,input:unknown,project:string|null,scope:string,result:unknown) {
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)').run(request_id,operation,hash(input),project,scope,JSON.stringify(result),now(),this.config.connection_id);
  }
  private snapshot<T>(build:()=>T):T {
    this.db.exec('BEGIN');
    try {return build();}
    finally {this.db.exec('ROLLBACK');}
  }
  private planHash(operation:string,input:unknown,impact:unknown) {
    return hash({operation,input,impact,authority:authority(this.config,this.db),generation:this.storage.generation()});
  }
  private syncLifecycle() {
    try {
      this.storage.transaction(()=>syncMaintenance(this.db,this.config));
      return {maintenance_synced:true};
    } catch(error) {
      return {maintenance_synced:false,error:error instanceof MemoryError?error.code:'MAINTENANCE_UNSYNCED_RESTORE_FORBIDDEN'};
    }
  }
  private find(id:string):Row {
    const row=this.db.prepare('SELECT * FROM memories WHERE id=?').get(id) as Row|undefined;
    if(!row)throw new MemoryError('MEMORY_NOT_FOUND');
    this.scope(row.project_id,row.scope);
    return row;
  }
  private currentOwner(id:string) {
    return this.db.prepare(`SELECT project_id,scope FROM memories WHERE id=?
      UNION ALL SELECT project_id,scope FROM tombstones WHERE id=?
      UNION ALL SELECT project_id,scope FROM retired_memories WHERE id=? LIMIT 1`).get(id,id,id) as Ownership|undefined;
  }
  async project(id:string,name:string,alias:string) {
    this.permission('manage');
    if(!this.config.all_projects && !this.config.allowed_projects.includes(id))throw new MemoryError('SCOPE_DENIED');
    const path=await realpath(alias);
    if(!(await stat(path)).isDirectory())throw new MemoryError('PROJECT_NOT_DIRECTORY');
    const result=this.storage.transaction(()=>{
      const existing=this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as Project|undefined;
      const previous=existing?JSON.parse(existing.aliases) as string[]:null;
      const aliases=[...new Set([...(previous??[]),path])];
      this.checkAliasCollision(id,aliases);
      if(!existing||name!==existing.name||hash(previous)!==hash(aliases)) {
        const action={kind:'project',project_id:id,name,previous,aliases} as const;
        this.saveAliases(action);
        appendAction(this.db,action);
        this.storage.advance();
      }
      return {project_id:id,name,aliases};
    });
    return {...result,...this.syncLifecycle()};
  }
  private checkAliasCollision(id:string,aliases:string[]) {
    const other=this.db.prepare("SELECT value alias FROM projects p,json_each(p.aliases) WHERE p.id<>?");
    const paths=new Set(aliases);
    for(const {alias} of other.iterate(id))if(paths.has(String(alias)))throw new MemoryError('ALIAS_CONFLICT');
  }
  private saveAliases(action:Extract<RecoveryAction,{kind:'project'}>) {
    this.db.prepare('INSERT INTO projects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,aliases=excluded.aliases')
      .run(action.project_id,action.name,JSON.stringify(action.aliases));
  }
  async projectAliases(raw:unknown,apply=false) {
    this.permission('manage');
    const {plan_hash,...input}=projectAliasesSchema.parse(raw);
    this.scope(input.project_id,'project');
    const change=()=>{
      const project=this.db.prepare('SELECT * FROM projects WHERE id=?').get(input.project_id) as Project;
      const previous=JSON.parse(project.aliases) as string[];
      const aliases=[...new Set(input.aliases.map(path=>{
        const canonical=realpathSync(path);
        if(!statSync(canonical).isDirectory())throw new MemoryError('PROJECT_NOT_DIRECTORY');
        return canonical;
      }))].sort();
      this.checkAliasCollision(project.id,aliases);
      const action={kind:'project',project_id:project.id,name:project.name,previous,aliases} as const;
      const digest=this.planHash('project_aliases',input,action);
      if(!apply)return {...action,plan_hash:digest,dry_run:true};
      if(plan_hash!==digest)throw new MemoryError(plan_hash?'PLAN_STALE':'PLAN_REQUIRED');
      this.saveAliases(action);
      appendAction(this.db,action);
      const result={project_id:project.id,aliases,generation:this.storage.advance(),dry_run:false};
      this.receipt(input.request_id,'project_aliases',{...input,plan_hash},project.id,'project',result);
      return result;
    };
    if(!apply)return this.snapshot(change);
    const result=this.storage.transaction(()=>this.event(input.request_id,'project_aliases',{...input,plan_hash})??change());
    return {...result,...this.syncLifecycle()};
  }
  private queueExportCleanup(ids:string[]) {
    for(const e of managedExports(this.db,ids))
      this.db.prepare("UPDATE exports SET status='pending_cleanup' WHERE id=?").run(e.id);
  }
  private clearProposal(id:string,status:string) {
    this.db.prepare("UPDATE proposals SET body=NULL,work_directory=NULL,admission_id=NULL,status=? WHERE id=? AND status='pending'").run(status,id);
    this.db.prepare('DELETE FROM proposal_transitions WHERE proposal_id=?').run(id);
    this.db.prepare('DELETE FROM import_targets WHERE proposal_id=?').run(id);
  }
  private moveRecords(action:Extract<RecoveryAction,{kind:'reassign'}>) {
    const {destination,records,recorded_at,written_by}=action;
    const ids=records.map(r=>r.memory_id),json=JSON.stringify(ids);
    for(const ref of records) {
      const row=this.find(ref.memory_id),record={...JSON.parse(row.body),...destination} as MemoryRecord;
      if(row.revision!==ref.revision||row.content_hash!==ref.content_hash||!sameOwnership(row,ref.previous)||
        recordHash(record)!==ref.next_hash)throw new MemoryError('REASSIGN_VERSION_CONFLICT');
      checkCurrentRule(this.db,record,[row.id],JSON.parse(row.body));
      const vectorUpdate=this.db.prepare('UPDATE memory_vec SET project_scope=? WHERE chunk_id=?');
      for(const chunk of this.db.prepare('SELECT id FROM memory_chunks WHERE memory_id=?').all(row.id))
        vectorUpdate.run(destination.project_id??'global',BigInt(Number(chunk.id)));
      this.db.prepare('UPDATE memories SET project_id=?,scope=?,body=?,revision=?,verified_at=?,written_by=?,content_hash=? WHERE id=?')
        .run(destination.project_id,destination.scope,JSON.stringify(record),row.revision+1,recorded_at,written_by,ref.next_hash,row.id);
      this.db.prepare('UPDATE memory_chunks SET revision=? WHERE memory_id=?').run(row.revision+1,row.id);
    }
    this.db.prepare(`UPDATE memory_relations SET project_id=?,scope=?
      WHERE from_id IN(SELECT value FROM json_each(?)) OR to_id IN(SELECT value FROM json_each(?))`)
      .run(destination.project_id,destination.scope,json,json);
    for(const table of ['learning_events','association_edges'])this.db.prepare(`UPDATE ${table} SET project_id=?,scope=?
      WHERE a IN(SELECT value FROM json_each(?)) OR b IN(SELECT value FROM json_each(?))`)
      .run(destination.project_id,destination.scope,json,json);
    for(const proposal of relatedProposals(this.db,ids))this.clearProposal(proposal.id,'invalidated');
    this.queueExportCleanup(ids);
    this.db.exec("UPDATE meta SET value=value+1 WHERE key='graph_epoch'");
  }
  async reassign(raw:unknown,apply=false) {
    this.permission('manage');
    const {plan_hash,...input}=reassignSchema.parse(raw);
    this.scope(input.destination.project_id,input.destination.scope);
    const change=()=>{
      const originals=input.records.map(ref=>{
        const row=this.find(ref.memory_id);
        if(row.revision!==ref.revision)throw new MemoryError('VERSION_CONFLICT');
        if(sameOwnership(row,input.destination))throw new MemoryError('NO_CHANGES');
        const record=JSON.parse(row.body) as MemoryRecord;
        checkCurrentRule(this.db,{...record,...input.destination},[row.id],record);
        return {...versionHead(row),previous:{project_id:row.project_id,scope:row.scope},next_hash:recordHash({...record,...input.destination})};
      });
      const authorized=(owner:Ownership)=>this.scope(owner.project_id,owner.scope);
      const impact=ownershipImpact(this.db,originals.map(r=>r.memory_id),input.destination,authorized);
      const digest=this.planHash('reassign',input,{originals,impact});
      if(!apply)return {records:originals,destination:input.destination,...impact,required_operation:'manage',plan_hash:digest,dry_run:true};
      if(plan_hash!==digest)throw new MemoryError(plan_hash?'PLAN_STALE':'PLAN_REQUIRED');
      if(impact.blocked.length)throw new MemoryError('REASSIGN_CROSS_SCOPE_REFERENCE');
      const action={kind:'reassign',records:originals,destination:input.destination,recorded_at:now(),written_by:this.config.connection_id} as const;
      this.moveRecords(action);
      this.checkpoint('reassign:updated');
      appendAction(this.db,action);
      const result={records:originals.map(r=>({memory_id:r.memory_id,revision:r.revision+1})),destination:input.destination,generation:this.storage.advance(),dry_run:false};
      this.receipt(input.request_id,'reassign',{...input,plan_hash},input.destination.project_id,input.destination.scope,result);
      return result;
    };
    if(!apply)return this.snapshot(change);
    const result=this.storage.transaction(()=>this.event(input.request_id,'reassign',{...input,plan_hash})??change());
    this.checkpoint('reassign:committed');
    return {...result,maintenance:await this.maintain()};
  }
  private resolvePath(path:string) {
    let absolute:string;
    try { absolute=realpathSync(path); if(!statSync(absolute).isDirectory())throw new MemoryError('PROJECT_NOT_DIRECTORY'); }
    catch(error:any) { if(error.code==='ENOENT'||error.code==='ENOTDIR')return {project_id:null,status:'directory_missing'}; throw error; }
    const matches=(this.db.prepare('SELECT id,aliases FROM projects').all() as {id:string;aliases:string}[])
      .flatMap(p=>(JSON.parse(p.aliases) as string[])
        .filter(a=>absolute===a || absolute.startsWith(a==='/'?a:a+'/')).map(alias=>({project_id:p.id,alias})));
    matches.sort((a,b)=>b.alias.length-a.alias.length);
    const match=matches[0];
    if(!match)return {project_id:null,status:'unregistered'};
    if(!this.config.all_projects&&!this.config.allowed_projects.includes(match.project_id))
      return {project_id:null,status:'unavailable'};
    return {...match,status:'resolved'};
  }
  async resolveProject(path:string) {
    this.permission('recall');
    return this.resolvePath(path);
  }
  private checkWorkDirectory(record:MemoryRecord,path:string|null|undefined) {
    if(!path)return;
    if(record.scope!=='project')throw new MemoryError('WORK_DIRECTORY_REQUIRES_PROJECT');
    const resolved=this.resolvePath(path);
    if(!resolved.project_id)throw new MemoryError('PROJECT_UNRESOLVED');
    if(resolved.project_id!==record.project_id)throw new MemoryError('PROJECT_MAPPING_MISMATCH');
  }
  private dependencies(record:MemoryRecord,target?:string,allowStale=false,matchingRevision?:(id:string,expected:number,current:number)=>boolean) {
    for(const dep of record.derived_from) {
      const parent=this.find(dep.memory_id);
      const evidence:MemoryRecord=JSON.parse(parent.body);
      if(!allowStale && (parent.status!=='active' ||
        (matchingRevision?!matchingRevision(parent.id,dep.revision,parent.revision):parent.revision!==dep.revision) ||
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
  private isRevoked(id:string,importKey:string|undefined,hashes:string[],sources:Pick<MemoryRecord['sources'][number],'source_hash'>[]=[]) {
    const sourceHashes=sources.flatMap(s=>s.source_hash?[s.source_hash]:[]);
    const keys=JSON.stringify([...hashes,...sourceHashes]);
    return this.db.prepare(`SELECT 1 FROM tombstones WHERE id=? OR import_key=? OR content_hash IN (SELECT value FROM json_each(?))
      UNION ALL SELECT 1 FROM revoked_version_hashes WHERE content_hash IN (SELECT value FROM json_each(?))
      UNION ALL SELECT 1 FROM revoked_aliases WHERE kind='import_key' AND value=?
      UNION ALL SELECT 1 FROM revoked_aliases WHERE kind='source_hash' AND value IN (SELECT value FROM json_each(?)) LIMIT 1`)
      .get(id,importKey??null,keys,keys,importKey??null,JSON.stringify(sourceHashes))!==undefined;
  }
  private isRetired(id:string) {
    return Boolean(id && this.db.prepare('SELECT 1 FROM retired_memories WHERE id=?').get(id));
  }
  private consolidationPackage(raw:unknown,matchingRevision?:(id:string,expected:number,current:number)=>boolean) {
    const input=consolidationPreviewSchema.parse(raw);
    this.scope(input.project_id,input.scope);
    return previewConsolidation(this.db,input,(id,record,digest)=>this.isRevoked(id,record.import_key,[digest],record.sources),matchingRevision);
  }
  consolidate(raw:unknown) {
    this.permission('manage');
    this.db.exec('BEGIN');
    try { return this.consolidationPackage(raw); }
    finally { this.db.exec('ROLLBACK'); }
  }
  private validateConsolidation(record:MemoryRecord,plan?:TransitionPlan,matchingRevision?:(id:string,expected:number,current:number)=>boolean) {
    if(!record.consolidation)return;
    if(plan?.transition&&plan.transition!=='new')throw new MemoryError('CONSOLIDATION_TRANSITION');
    const {expires_at,...context}=record.valid_for;
    const report=this.consolidationPackage({project_id:record.project_id,scope:record.scope,title:record.title,
      claim:record.content,kind:record.kind,context,evidence:record.consolidation},matchingRevision);
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
  private transitionTargets(record:MemoryRecord,plan:TransitionPlan|undefined,source?:string,preview=false) {
    const targets=new Map<string,Row>();
    if(plan?.version_evolution) {
      this.sourceCheck({...record,sources:plan.version_evolution.sources});
      if(this.isRevoked('',undefined,[],plan.version_evolution.sources))throw new MemoryError('REVOKED_IMPORT');
    }
    for(const ref of plan?.expected_refs??[]) {
      if(ref.memory_id===source)throw new MemoryError('RELATION_SELF');
      const row=this.find(ref.memory_id);
      if(row.revision!==ref.revision || row.status!=='active')throw new MemoryError('VERSION_CONFLICT');
      if(row.scope!==record.scope || row.project_id!==record.project_id)throw new MemoryError('RELATION_SCOPE');
      const previous:MemoryRecord=JSON.parse(row.body);
      const identity=this.legacyIdentity(record,plan);
      validateTransition(record,{...previous,subject_id:previous.subject_id??identity?.subject_id,
        context_key:previous.context_key??identity?.context_key},plan?.transition,plan?.version_evolution);
      if(!preview&&plan?.transition==='supersede' && previous.verification.status==='verified')this.permission('verify');
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
  private legacyIdentity(record:MemoryRecord,plan?:TransitionPlan) {
    if(!plan?.version_evolution?.adopt_legacy_identity)return undefined;
    if(!record.subject_id||!record.context_key)throw new MemoryError('RULE_IDENTITY_REQUIRED');
    return {subject_id:record.subject_id,context_key:record.context_key};
  }
  private readTransition(id:string) {
    const row=this.db.prepare('SELECT plan FROM proposal_transitions WHERE proposal_id=?').get(id);
    return row?String(row.plan):null;
  }
  private prepareRevision(input:ProposeInput,supplied:object,plan:TransitionPlan|undefined,preview=false) {
    if(!input.target_id)return;
    const {record}=input,target=this.find(input.target_id);
    if(target.status!=='active'||target.revision!==input.expected_revision)throw new MemoryError('VERSION_CONFLICT');
    if(!sameOwnership(target,record))throw new MemoryError('SCOPE_IMMUTABLE');
    const previous=JSON.parse(target.body) as MemoryRecord;
    for(const key of ['tags','valid_for','derived_from','import_key','memory_form','episode','valid_time','decision_state','lifecycle','subject_id','context_key','consolidation'] as const) {
      if(!Object.hasOwn(supplied,key)&&previous[key]!==undefined)(record as any)[key]=previous[key];
    }
    if(previous.lifecycle==='historical'&&record.lifecycle==='current')throw new MemoryError('HISTORICAL_REACTIVATION');
    if(plan?.transition==='supersede') {
      if((previous.lifecycle??'current')!=='current')throw new MemoryError('TRANSITION_LIFECYCLE_CONFLICT');
      if(!preview&&previous.verification.status==='verified')this.permission('verify');
      if(previous.subject_id&&previous.subject_id!==record.subject_id || previous.context_key&&previous.context_key!==record.context_key ||
        (['branch','environment','commit'] as const).some(key=>previous.valid_for[key]&&previous.valid_for[key]!==record.valid_for[key]))
        throw new MemoryError('TRANSITION_SUCCESSOR_IDENTITY');
    }
    if(record.consolidation&&!previous.consolidation)throw new MemoryError('CONSOLIDATION_REQUIRES_NEW_RECORD');
    return previous;
  }
  async admissionPreview(raw:unknown) {
    this.permission('recall');
    const {candidate,intent,suggestions}=admissionSchema.parse(raw),{record}=candidate;
    this.scope(record.project_id,record.scope);
    this.sourceCheck(record);
    const supplied=(raw as {candidate:{record:object}}).candidate.record,digest=admissionDigest(candidate,supplied);
    const before=this.storage.generation();
    const analogues=suggestions&&!['progress','receipt','temporary'].includes(intent)
      ? await this.recall({query:(record.title+' '+record.content).slice(0,512),project_id:record.project_id??undefined,
        include_global:record.scope==='global',context:{branch:record.valid_for.branch,commit:record.valid_for.commit,environment:record.valid_for.environment},
        view:'evidence',limit:6}) : undefined;
    return this.snapshot(()=>{
      const generation=this.storage.generation(),plan=transitionPlan(candidate);
      const previous=this.prepareRevision(candidate,supplied,plan,true);
      const decision=admissionDecision(this.db,candidate,record,intent,previous);
      const comparable=analogues?.generation===before&&before===generation
        ? analogues.items.filter((item:any)=>sameOwnership(item,record))
          .map((item:any)=>({memory_id:item.id,revision:item.revision,evidence_strength:item.evidence_strength})):undefined;
      const {ready,...details}=decision;
      const result={...details,generation,policy:ADMISSION_POLICY,advisory:true,
        ...(analogues&&{suggestions:comparable??[],suggestion_mode:comparable&&analogues.retrieval_mode})};
      if(!ready)return result;
      const targets=this.transitionTargets(record,plan,candidate.target_id,true);
      this.validateConsolidation(record,plan);
      this.dependencies(record,candidate.target_id);
      if(this.isRevoked(candidate.target_id??'',record.import_key,[recordHash(record)],record.sources))throw new MemoryError('REVOKED_IMPORT');
      checkCurrentRule(this.db,record,[...(candidate.target_id?[candidate.target_id]:[]),
        ...(plan?.transition==='supersede'?[...targets.keys()]:[])],previous);
      const required_operations:Config['operations']=['propose','commit'];
      if(record.verification.status==='verified'||plan?.transition==='supersede'&&
        (previous?.verification.status==='verified'||[...targets.values()].some(r=>JSON.parse(r.body).verification.status==='verified')))
        required_operations.push('verify');
      const blockers=required_operations.filter(op=>!this.config.operations.includes(op)).map(op=>'OPERATION_DENIED:'+op);
      if(this.config.require_work_directory&&record.scope==='project'&&!candidate.target_id&&!candidate.work_directory&&
        !this.config.operations.includes('manage'))blockers.push('WORK_DIRECTORY_REQUIRED');
      this.checkWorkDirectory(record,candidate.work_directory);
      if(blockers.length)return {...result,required_operations,blockers};
      const refs=[...(candidate.target_id?[{memory_id:candidate.target_id,revision:candidate.expected_revision!}]:[]),
        ...candidate.expected_refs??[],...record.derived_from,...decision.related];
      const admission_id=randomUUID(),state=QueryState.open(this.db,this.config);
      const until=state.saveLease('admission',admission_id,authority(this.config,this.db),generation,
        JSON.stringify({policy:ADMISSION_POLICY,digest,refs}),Date.now()+600_000);
      return {...result,required_operations,admission_id,expires_at:new Date(until).toISOString()};
    });
  }
  taskOverride(raw:unknown) {
    this.permission('recall');
    const input=taskOverrideSchema.parse(raw);
    for(const exclusion of input.exclude_subjects)this.scope(exclusion.owner.project_id,exclusion.owner.scope);
    return this.snapshot(()=>startTaskOverride(this.db,this.config,this.storage.generation(),input.task_id,
      {ids:input.exclude_ids.map(id=>id.toLowerCase()),subjects:input.exclude_subjects},input.ttl_seconds));
  }
  private validateAdmission(id:string,digest?:string) {
    return checkAdmission(this.db,QueryState.open(this.db,this.config),this.config,this.storage.generation(),id,digest);
  }
  private validateViewScope(input:Pick<ViewScope,'project_id'|'include_global'>) {
    if(input.project_id)this.scope(input.project_id,'project');
    if(input.include_global??(!input.project_id&&this.config.allow_global))this.scope(null,'global');
  }
  browse(raw:unknown) {
    this.permission('recall');
    const input=browseSchema.parse(raw),route=catalogRoute(input.uri);
    if(input.exclude_ids)input.exclude_ids=[...new Set(input.exclude_ids.map(id=>id.toLowerCase()))].sort();
    if(route.global&&(input.project_id||input.include_global===false)||
      route.project_id&&(input.project_id&&input.project_id!==route.project_id||input.include_global===true))
      throw new MemoryError('CATALOG_SCOPE_MISMATCH');
    this.validateViewScope(route.global?{include_global:true}:route.project_id?{project_id:route.project_id}:input);
    return this.snapshot(()=>browseCatalog(this.db,this.config,this.storage.generation(),input,route));
  }
  async inspectMemory(raw:unknown) {
    const {memory_id,revision,...scope}=inspectMemorySchema.parse(raw);
    return this.recall({...scope,...(revision?{versions:[{memory_id,revision}]}:{ids:[memory_id]})});
  }
  async contextPack(raw:unknown) {
    this.permission('recall');
    if(!this.config.context_pack_enabled)throw new MemoryError('CONTEXT_PACK_DISABLED');
    const {read,needed}=contextPackSchema.parse(raw);
    if(!needed)return {pack:'deterministic-v1',evidence_status:'not_needed',items:[]};
    const input={...read!,view:read!.view??'evidence' as const};
    const page=await this.recall(input);
    return this.snapshot(()=>{
      if(page.generation!==this.storage.generation())throw new MemoryError('VIEW_STALE');
      if(input.task_id)taskExclusions(this.db,this.config,page.generation,input.task_id);
      return packEvidence(this.db,this.config,input,page);
    });
  }
  explainMemory(raw:unknown) {
    this.permission('recall');
    const input=inspectMemorySchema.parse(raw);
    if(input.exclude_ids)input.exclude_ids=input.exclude_ids.map(id=>id.toLowerCase());
    this.validateViewScope(input);
    return this.snapshot(()=>explainVisibility(this.db,this.config,this.storage.generation(),input));
  }
  classify(raw:unknown,apply=false) {
    this.permission('manage');
    const {plan_hash,records}=classifySchema.parse(raw);
    const project=()=>{
      const changed:AnchoredClaim[]=[];
      const audited=records.map(ref=>{
        const row=this.find(ref.memory_id);
        if(row.revision!==ref.revision||row.status!=='active')throw new MemoryError('VERSION_CONFLICT');
        const {project_id,scope,content_hash}=row;
        const old=this.db.prepare('SELECT subject_id,context_key,aliases,start,end FROM claim_projection WHERE memory_id=?').get(ref.memory_id);
        const before=old?{...old,aliases:JSON.parse(String(old.aliases))}:null;
        if('remove' in ref)return {...ref,project_id,scope,content_hash,before};
        const record=JSON.parse(row.body) as MemoryRecord;
        if((record.lifecycle??'current')!=='current')throw new MemoryError('PROJECTION_REQUIRES_CURRENT');
        if(record.subject_id&&record.subject_id!==ref.subject_id||record.context_key&&record.context_key!==ref.context_key)
          throw new MemoryError('PROJECTION_CANONICAL_IDENTITY');
        if(ref.end>record.content.length||/[\uDC00-\uDFFF]/.test(record.content[ref.start]??'')||
          /[\uD800-\uDBFF]/.test(record.content[ref.end-1]??''))throw new MemoryError('PROJECTION_SPAN_INVALID');
        const change={...ref,project_id,scope,content_hash,kind:record.kind,decision_state:record.decision_state,environment:record.valid_for?.environment};
        changed.push(change);
        return {...change,before,valid_time:record.valid_time,valid_for:record.valid_for,
          span:record.content.slice(ref.start,ref.end),sources:record.sources.map(sourceStatus)};
      });
      const ids=records.map(ref=>ref.memory_id);
      validateSubjectAliases(this.db,changed,ids);
      const digest=this.planHash('classify',records,audited);
      if(!apply)return {records:audited,generation:this.storage.generation(),plan_hash:digest,dry_run:true};
      if(plan_hash!==digest)throw new MemoryError(plan_hash?'PLAN_STALE':'PLAN_REQUIRED');
      const counts={attached:0,removed:0};
      const del=this.db.prepare('DELETE FROM claim_projection WHERE memory_id=?');
      for(const ref of records)counts.removed+=Number(del.run(ref.memory_id).changes);
      const insert=this.db.prepare('INSERT INTO claim_projection VALUES(?,?,?,?,?,?,?,?)');
      for(const ref of changed){
        insert.run(ref.memory_id,ref.revision,ref.content_hash,ref.subject_id,ref.context_key,JSON.stringify(ref.aliases),ref.start,ref.end);
        counts.attached++;
      }
      return {...counts,generation:counts.attached||counts.removed?this.storage.advance():this.storage.generation(),dry_run:false};
    };
    return apply?this.storage.transaction(project):this.snapshot(project);
  }
  async propose(raw:unknown,importTarget?:{id:string;revision:number}) {
    this.permission('propose');
    if(importTarget)this.permission('manage');
    const input=proposeSchema.parse(raw),record=input.record;
    const fingerprint={...input,record:{...record}};
    const plan=transitionPlan(input),supplied=(raw as {record:object}).record;
    this.scope(record.project_id,record.scope); this.sourceCheck(record);
    return this.storage.transaction(()=>{
      const retry=this.event(input.request_id,'propose',fingerprint); if(retry)return retry;
      const admissionExpires=input.admission_id?this.validateAdmission(input.admission_id,admissionDigest(input,supplied)):undefined;
      if(this.config.require_work_directory && record.scope==='project'&&!input.target_id&&!input.work_directory&&
        !this.config.operations.includes('manage'))throw new MemoryError('WORK_DIRECTORY_REQUIRED');
      this.checkWorkDirectory(record,input.work_directory);
      const previous=this.prepareRevision(input,supplied,plan);
      if(record.verification.status==='verified'){
        this.permission('verify');
        if(['source_claim','model_inference'].includes(record.verification.basis) || !record.verification.evidence)throw new MemoryError('VERIFICATION_EVIDENCE_REQUIRED');
      }
      const {reviewer,reviewed_at,...verification}=record.verification;
      record.verification=verification.status==='unverified'?verification:{...verification,reviewer:this.config.connection_id,reviewed_at:now()};
      if(plan?.transition==='quarantine')record.lifecycle='quarantined';
      const targets=this.transitionTargets(record,plan,input.target_id);
      this.validateConsolidation(record,plan);
      this.dependencies(record,input.target_id);
      if(this.isRevoked('',record.import_key,[recordHash(record)],record.sources))throw new MemoryError('REVOKED_IMPORT');
      if(record.import_key) {
        const duplicate=this.db.prepare('SELECT id,revision,project_id,scope FROM memories WHERE import_key=?').get(record.import_key) as any;
        if(duplicate && duplicate.id!==input.target_id)throw new MemoryError('IMPORT_ALREADY_EXISTS');
      }
      const replaced=plan?.transition==='supersede'?[...targets.keys()]:[];
      checkCurrentRule(this.db,record,[...(input.target_id?[input.target_id]:[]),...replaced],previous);
      if(!importTarget)checkDuplicate(this.db,record,previous,plan?.transition??(plan?.relations?.length?'relation':undefined));
      const similarQuery=ftsQuery(record.title+' '+record.content);
      const candidates=similarQuery?this.db.prepare(`WITH matches AS MATERIALIZED (
        SELECT f.memory_id,bm25(chunk_fts) rank FROM chunk_fts f
        JOIN memory_chunks c ON c.id=f.chunk_id AND c.memory_id=f.memory_id
        JOIN memories m ON m.id=c.memory_id AND m.revision=c.revision AND m.profile_id=c.profile_id
        WHERE chunk_fts MATCH ? AND m.status='active' AND m.scope=? AND m.project_id IS ?
      ), best AS (
        SELECT memory_id,min(rank) rank FROM matches GROUP BY memory_id ORDER BY rank,memory_id LIMIT 20
      ) SELECT m.id,m.revision,m.body FROM best JOIN memories m ON m.id=best.memory_id ORDER BY best.rank,m.id`)
        .all(similarQuery,record.scope,record.project_id) as any[]:[];
      const words=new Set(terms(record.title+' '+record.content));
      const similar=candidates.map(x=>({memory_id:x.id,revision:x.revision,overlap:terms(JSON.parse(x.body).title+' '+JSON.parse(x.body).content).filter(w=>words.has(w)).length})).filter(x=>x.overlap>=3).sort((a,b)=>b.overlap-a.overlap).slice(0,5);
      const id=randomUUID();
      const regular=expires(this.config.retention.proposal_days);
      const expires_at=admissionExpires?new Date(Math.min(admissionExpires,Date.parse(regular))).toISOString():regular;
      this.db.prepare(`INSERT INTO proposals(id,project_id,scope,body,target_id,expected_revision,status,created_at,connection_id,work_directory,expires_at,admission_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,record.project_id,record.scope,JSON.stringify(record),input.target_id??null,input.expected_revision??0,'pending',now(),this.config.connection_id,input.work_directory??null,expires_at,input.admission_id??null);
      if(plan)this.db.prepare('INSERT INTO proposal_transitions VALUES(?,?)').run(id,JSON.stringify(plan));
      if(importTarget)this.db.prepare('INSERT INTO import_targets VALUES(?,?,?)').run(id,importTarget.id,importTarget.revision);
      const result={proposal_id:id,expected_revision:input.expected_revision??0,expires_at,similar_candidates:similar,missing_fields:[],
        ...(plan&&{planned_transition:{transition:plan.transition,expected_refs:plan.expected_refs,
          relations:plan.relations?.map(({type,target_id})=>({type,target_id}))}}),
        warning:'Similarity does not establish contradiction or permission to merge.'};
      this.receipt(input.request_id,'propose',fingerprint,record.project_id,record.scope,result);
      return result;
    });
  }
  private pendingProposal(id:string) {
    const proposal=this.db.prepare('SELECT * FROM proposals WHERE id=?').get(id) as any;
    if(!proposal)throw new MemoryError('PROPOSAL_NOT_FOUND');
    this.scope(proposal.project_id,proposal.scope);
    if(proposal.status==='expired'||proposal.status==='pending'&&
      !(Date.parse(proposal.expires_at)>Date.now()))throw new MemoryError('PROPOSAL_EXPIRED');
    if(proposal.status!=='pending')throw new MemoryError('PROPOSAL_NOT_PENDING');
    return proposal;
  }
  renewProposal(raw:unknown) {
    this.permission('propose');
    const input=proposalRenewSchema.parse(raw);
    return this.storage.transaction(()=>{
      const retry=this.event(input.request_id,'renew_proposal',input);if(retry)return retry;
      const proposal=this.pendingProposal(input.proposal_id);
      if(proposal.connection_id!==this.config.connection_id)throw new MemoryError('PROPOSAL_OWNER_MISMATCH');
      const regular=expires(this.config.retention.proposal_days),limit=proposal.admission_id?this.validateAdmission(proposal.admission_id):undefined;
      const expires_at=limit?new Date(Math.min(limit,Date.parse(regular))).toISOString():regular;
      this.db.prepare('UPDATE proposals SET expires_at=? WHERE id=?').run(expires_at,proposal.id);
      const result={proposal_id:proposal.id,expires_at};
      this.receipt(input.request_id,'renew_proposal',input,proposal.project_id,proposal.scope,result);
      return result;
    });
  }
  private deleteIndexes(id:string) {
    const chunks=this.db.prepare('SELECT id FROM memory_chunks WHERE memory_id=?').all(id) as any[];
    for(const c of chunks)this.db.prepare('DELETE FROM memory_vec WHERE chunk_id=?').run(BigInt(c.id));
    this.db.prepare('DELETE FROM memory_chunks WHERE memory_id=?').run(id);
  }
  private descendants(id:string) {
    return (this.db.prepare(`WITH RECURSIVE children(id) AS(SELECT child_id FROM dependencies WHERE parent_id=? UNION SELECT d.child_id FROM dependencies d JOIN children c ON d.parent_id=c.id) SELECT id FROM children`).all(id) as any[]).map(x=>x.id as string);
  }
  private invalidate(ids:string[],erase:boolean) {
    if(!ids.length)return;
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
    for(const p of relatedProposals(this.db,ids))this.clearProposal(p.id,'invalidated');
  }
  private eraseProposals(ids:string[],versionHashes:string[],importKeys:string[],sourceHashes:string[]) {
    const affected=new Set(relatedProposals(this.db,ids).map(p=>p.id));
    const hashes=new Set(versionHashes),imports=new Set(importKeys),sources=new Set(sourceHashes);
    const rows=this.db.prepare(`SELECT p.id,p.project_id,p.scope,p.body,t.plan FROM proposals p
      LEFT JOIN proposal_transitions t ON t.proposal_id=p.id WHERE p.status='pending' ORDER BY p.id`).all() as
      (Ownership&{id:string;body:string;plan:string|null})[];
    return rows.filter(p=>{
      if(affected.has(p.id))return true;
      const r:MemoryRecord=JSON.parse(p.body),plan:TransitionPlan|undefined=p.plan?JSON.parse(p.plan):undefined;
      const evidence=[...r.sources,...(plan?.relations??[]).flatMap(e=>e.sources),...(plan?.version_evolution?.sources??[])];
      return Boolean(r.import_key&&imports.has(r.import_key) || hashes.has(recordHash(r)) ||
        evidence.some(e=>e.source_hash&&(sources.has(e.source_hash)||hashes.has(e.source_hash))) ||
        this.isRevoked('',r.import_key,[recordHash(r)],evidence));
    });
  }
  private supersede(target:Row,cutoff:string,recordedAt:string,writer:string,identity?:{subject_id:string;context_key:string}) {
    const before:MemoryRecord=JSON.parse(target.body);
    const previous=supersededRecord({...before,...identity},cutoff);
    const revision=target.revision+1;
    const changed=this.db.prepare("UPDATE memories SET body=?,revision=?,verified_at=?,content_hash=?,written_by=? WHERE id=? AND revision=? AND status='active'")
      .run(JSON.stringify(previous),revision,recordedAt,recordHash(previous),writer,target.id,target.revision);
    if(Number(changed.changes)!==1)throw new MemoryError('VERSION_CONFLICT');
    this.db.prepare('UPDATE memory_chunks SET revision=? WHERE memory_id=? AND revision=?').run(revision,target.id,target.revision);
    this.invalidate(this.descendants(target.id),false);
    return {...versionHead(target),next_hash:recordHash(previous)};
  }
  private writeRelations(id:string,revision:number,record:MemoryRecord,plan:TransitionPlan,targets:Map<string,Row>,recordedAt:string) {
    const generatedType=plan.transition==='supersede'?'supersedes' as const:plan.transition==='branch'?'context_variant' as const:plan.transition==='reinforce'?'supports' as const:undefined;
    const relations=generatedType
      ? [...targets.keys()].map(target_id=>({target_id,type:generatedType,sources:plan.version_evolution?.sources??record.sources}))
      : [];
    const insert=this.db.prepare('INSERT INTO memory_relations VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    return [...relations,...(plan.relations??[])].map(({target_id,type,sources})=>{
      const relationId=randomUUID();
      const targetRevision=targets.get(target_id)!.revision+(plan.transition==='supersede'?1:0);
      insert.run(relationId,1,id,revision,target_id,targetRevision,type,record.project_id,record.scope,JSON.stringify(sources),recordedAt);
      return {id:relationId,revision:1,type,from:{memory_id:id,revision},to:{memory_id:target_id,revision:targetRevision}};
    });
  }
  async commit(raw:unknown) {
    this.permission('commit'); const input=commitSchema.parse(raw);
    const retry=this.event(input.request_id,'commit',input); if(retry)return retry.lifecycle_changed?{...retry,...this.syncLifecycle()}:retry;
    const proposal=this.pendingProposal(input.proposal_id);
    if(proposal.expected_revision!==input.expected_revision)throw new MemoryError('VERSION_CONFLICT');
    if(proposal.admission_id)this.validateAdmission(proposal.admission_id);
    const record:MemoryRecord=JSON.parse(proposal.body); if(record.verification.status==='verified')this.permission('verify'); this.sourceCheck(record);this.dependencies(record,proposal.target_id);
    const storedPlan=this.readTransition(proposal.id);
    const plan:TransitionPlan|undefined=storedPlan?JSON.parse(storedPlan):undefined;
    this.validateConsolidation(record,plan);
    this.transitionTargets(record,plan,proposal.target_id);
    let chunks,profile;
    try { profile=await this.encoder.profile(); chunks=await this.encoder.chunks(record.title,record.content); }
    catch(error) { if(error instanceof MemoryError && error.code==='QUERY_TOO_LONG')throw error;throw new MemoryError('EMBEDDING_UNAVAILABLE'); }
    this.checkpoint('after_embedding');
    const result=this.storage.transaction(()=>{
      this.checkpoint('begin');
      const repeated=this.event(input.request_id,'commit',input);if(repeated)return repeated;
      const current=this.pendingProposal(input.proposal_id);
      if(current.body!==proposal.body || current.admission_id!==proposal.admission_id || this.readTransition(proposal.id)!==storedPlan)throw new MemoryError('PROPOSAL_NOT_PENDING');
      if(current.admission_id)this.validateAdmission(current.admission_id);
      this.scope(record.project_id,record.scope); this.dependencies(record,proposal.target_id);
      this.checkWorkDirectory(record,current.work_directory);
      this.validateConsolidation(record,plan);
      const targets=this.transitionTargets(record,plan,proposal.target_id);
      const otherProfile=this.db.prepare("SELECT profile_id FROM memories WHERE status='active' AND profile_id!=? LIMIT 1").get(profile.id);
      if(otherProfile)throw new MemoryError('INDEX_PROFILE_MISMATCH');
      const imported=this.db.prepare('SELECT * FROM import_targets WHERE proposal_id=?').get(proposal.id) as any;
      const id=proposal.target_id??imported?.memory_id??randomUUID();
      const old=proposal.target_id?this.find(id):null;
      if(this.isRetired(id))throw new MemoryError('MEMORY_RETIRED');
      if(old && (old.revision!==input.expected_revision || old.status!=='active'))throw new MemoryError('VERSION_CONFLICT');
      if(record.import_key&&this.db.prepare('SELECT 1 FROM memories WHERE import_key=? AND id<>?').get(record.import_key,id))
        throw new MemoryError('IMPORT_ALREADY_EXISTS');
      const previous:MemoryRecord|undefined=old?JSON.parse(old.body):undefined;
      if(plan?.transition==='supersede'&&previous?.verification.status==='verified')this.permission('verify');
      checkCurrentRule(this.db,record,[id,...(plan?.transition==='supersede'?[...targets.keys()]:[])],previous);
      if(!imported)checkDuplicate(this.db,record,previous,plan?.transition??(plan?.relations?.length?'relation':undefined));
      const contentHash=recordHash(record);
      if(this.isRevoked(id,record.import_key,[contentHash],record.sources))throw new MemoryError('REVOKED_IMPORT');
      this.db.prepare('INSERT OR IGNORE INTO embedding_profiles VALUES(?,?)').run(profile.id,JSON.stringify(profile.manifest));
      this.checkpoint('profile');
      if(!old && this.db.prepare('SELECT id FROM memories WHERE id=?').get(id))throw new MemoryError('IMPORT_ID_CONFLICT');
      const revision=old?old.revision+1:imported?.revision??1;
      const recordedAt=now();
      const reuseIndexes=Boolean(old&&previous&&plan?.transition==='supersede'&&old.profile_id===profile.id&&
        previous.title===record.title&&previous.content===record.content&&hash(previous.tags)===hash(record.tags)&&
        this.db.prepare('SELECT 1 FROM memory_chunks WHERE memory_id=? LIMIT 1').get(id)&&
        !this.db.prepare(`SELECT 1 FROM memory_chunks c WHERE c.memory_id=? AND (c.revision<>? OR
          c.profile_id<>? OR c.id NOT IN (SELECT chunk_id FROM memory_vec)
          OR NOT EXISTS (SELECT 1 FROM chunk_fts WHERE chunk_id=c.id AND memory_id=c.memory_id)) LIMIT 1`).get(id,old.revision,profile.id));
      if(old) {
        this.invalidate(this.descendants(id),false);
        if(!reuseIndexes)this.deleteIndexes(id);
      }
      if(old&&plan)this.transitionTargets(record,plan,id);
      let predecessors:ReturnType<MemoryService['supersede']>[]=[];
      const identity=this.legacyIdentity(record,plan);
      if(plan?.transition==='supersede') {
        predecessors=[...targets.values()].map(target=>this.supersede(target,record.valid_time!.valid_from!,recordedAt,this.config.connection_id,identity));
        this.dependencies(record);
        this.checkpoint('transition:predecessors');
      }
      this.checkpoint('index_delete');
      this.db.prepare(`INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,revision=excluded.revision,status=excluded.status,verified_at=excluded.verified_at,profile_id=excluded.profile_id,content_hash=excluded.content_hash,import_key=excluded.import_key,written_by=excluded.written_by`).run(id,record.project_id,record.scope,JSON.stringify(record),revision,'active',old?.created_at??recordedAt,recordedAt,profile.id,contentHash,record.import_key??null,this.config.connection_id);
      this.checkpoint('row');
      this.db.prepare('DELETE FROM dependencies WHERE child_id=?').run(id);
      for(const dep of record.derived_from)this.db.prepare('INSERT INTO dependencies VALUES(?,?,?)').run(id,dep.memory_id,dep.revision);
      this.checkpoint('dependencies');
      if(reuseIndexes)this.db.prepare('UPDATE memory_chunks SET revision=? WHERE memory_id=?').run(revision,id);
      else this.indexChunks(id,revision,profile.id,record,chunks);
      this.checkpoint('chunks');
      this.checkpoint('fts');
      const relations=plan?this.writeRelations(id,revision,record,plan,targets,recordedAt):undefined;
      if(predecessors.length)appendAction(this.db,{kind:'supersede',successor:{memory_id:id,revision,content_hash:contentHash},
        previous_successor:old?versionHead(old):undefined,identity,cutoff:record.valid_time!.valid_from!,recorded_at:recordedAt,
        written_by:this.config.connection_id,predecessors,relations:(relations??[]).map(({id,type,from,to})=>({id,type,from,to,
          source_signatures:(JSON.parse(String(this.db.prepare('SELECT sources FROM memory_relations WHERE id=?').get(id)!.sources)) as
            MemoryRecord['sources']).map(hash)}))});
      if(relations?.length)this.db.exec("UPDATE meta SET value=value+1 WHERE key='graph_epoch'");
      this.clearProposal(proposal.id,'committed');
      this.checkpoint('proposal');
      const result={memory_id:id,revision,generation:this.storage.advance(),embedding_profile_id:profile.id,written_by:this.config.connection_id,
        ...(relations?.length&&{relations}),...(predecessors.length>0&&{lifecycle_changed:true})};
      this.receipt(input.request_id,'commit',input,record.project_id,record.scope,result);this.checkpoint('receipt');return result;
    });
    if(!result.lifecycle_changed)return result;
    this.checkpoint('transition:committed');
    return {...result,...this.syncLifecycle()};
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
    if(input.exclude_ids)input.exclude_ids=[...new Set(input.exclude_ids.map(id=>id.toLowerCase()))].sort();
    if(input.exact_only && (!input.query || identifiers(input.query).length===0))throw new MemoryError('EXACT_IDENTIFIER_REQUIRED');
    this.validateViewScope(input);
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
  private forgetPlan(input:{memory_id:string;expected_revision:number}) {
    const root=this.find(input.memory_id);
    if(root.revision!==input.expected_revision)throw new MemoryError('VERSION_CONFLICT');
    const ids=erasureTree(this.db,root.id),list=JSON.stringify(ids);
    const records=ids.map(id=>this.find(id)).map(row=>({...versionHead(row),project_id:row.project_id,scope:row.scope}));
    const versions=this.db.prepare(`SELECT memory_id,revision,body_state,content_hash FROM memory_versions
      WHERE memory_id IN (SELECT value FROM json_each(?)) ORDER BY memory_id,revision`).all(list);
    const dependencies=this.db.prepare(`SELECT parent_id,child_id,child_revision,parent_revision FROM version_dependencies
      WHERE parent_id IN (SELECT value FROM json_each(?)) ORDER BY parent_id,child_id,child_revision`).all(list);
    const aliases=this.db.prepare(`SELECT DISTINCT kind,value FROM version_aliases
      WHERE memory_id IN (SELECT value FROM json_each(?)) ORDER BY kind,value`).all(list);
    const aliasValues=(kind:string)=>aliases.filter(a=>a.kind===kind).map(a=>String(a.value));
    const proposals=this.eraseProposals(ids,versions.map(v=>String(v.content_hash)),aliasValues('import_key'),aliasValues('source_hash'))
      .map(p=>{
        this.scope(p.project_id,p.scope);
        return {id:p.id,fingerprint:hash([p.body,p.plan])};
      });
    const exports=managedExports(this.db,ids).map(({id,ids,status})=>{
      for(const entry of JSON.parse(ids) as string[]){
        const owner=this.currentOwner(entry);
        if(owner)this.scope(owner.project_id,owner.scope);
      }
      return {id,status};
    });
    const indexes={chunks:this.db.prepare('SELECT count(*) n FROM memory_chunks WHERE memory_id IN(SELECT value FROM json_each(?))').get(list)!.n,
      vectors:this.db.prepare(`SELECT count(*) n FROM memory_vec v JOIN memory_chunks c ON c.id=v.chunk_id
        WHERE c.memory_id IN (SELECT value FROM json_each(?))`).get(list)!.n,
      fts:this.db.prepare('SELECT count(*) n FROM chunk_fts WHERE memory_id IN(SELECT value FROM json_each(?))').get(list)!.n};
    const hash_copies=this.db.prepare(`SELECT DISTINCT a.memory_id first,b.memory_id second
      FROM memory_versions a JOIN memory_versions b ON a.content_hash=b.content_hash AND a.memory_id<b.memory_id
      WHERE a.memory_id IN (SELECT value FROM json_each(?)) ORDER BY first,second`).all(list);
    const info={records,versions,dependencies,proposals,exports,indexes,hash_copies};
    return {root,ids,info,plan_hash:this.planHash('forget',input,info)};
  }
  forgetPreview(raw:unknown) {
    this.permission('forget');
    const input=forgetPreviewSchema.parse(raw);
    return this.snapshot(()=>{
      const {plan_hash,info}=this.forgetPlan(input);
      return {...info,proposals:info.proposals.map(p=>p.id),plan_hash,generation:this.storage.generation(),required_operation:'forget'};
    });
  }
  async forget(raw:unknown) {
    this.permission('forget');const input=forgetSchema.parse(raw);
    if(!input.plan_hash)throw new MemoryError('FORGET_PREVIEW_REQUIRED');
    const result=this.storage.transaction(()=>{
      const retry=this.event(input.request_id,'forget',input);if(retry)return retry;
      const {root,ids,info,plan_hash}=this.forgetPlan({memory_id:input.memory_id,expected_revision:input.expected_revision});
      if(input.plan_hash!==plan_hash)throw new MemoryError('PLAN_STALE');
      this.invalidate(ids,true);
      for(const p of info.proposals)this.clearProposal(p.id,'invalidated');
      this.queueExportCleanup(ids);
      const generation=this.storage.advance();
      this.checkpoint('forget:erased');
      this.db.prepare("INSERT OR REPLACE INTO meta VALUES('cache_erasure_before',?)").run(generation);
      this.db.prepare("INSERT OR REPLACE INTO meta VALUES('revocations_pending',1)").run();
      const result={memory_id:root.id,forgotten:true,derived_erased:ids.length-1,generation,main_bodies:'cleared',logical_indexes:'cleared',
        outside_control:['prior chat/tool context','unmanaged backups','OS snapshots','SSD forensic erasure']};
      this.receipt(input.request_id,'forget',input,root.project_id,root.scope,result);return result;
    });
    this.checkpoint('forget:committed');
    const maintenance=await this.maintain();
    return {...result,cleanup:maintenance.errors.length?'pending':'complete',maintenance};
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
        const root=join(dirname(this.config.database),'exports');
        if(![join(root,entry.id+'.md'),join(root,entry.id+'.json')].includes(entry.path)) {
          errors.push('EXPORT_CLEANUP_PENDING');continue;
        }
        try {unlinkSync(entry.path);this.db.prepare("UPDATE exports SET status='removed' WHERE id=?").run(entry.id);}
        catch(e:any) {if(e.code==='ENOENT')this.db.prepare("UPDATE exports SET status='removed' WHERE id=?").run(entry.id);else errors.push('EXPORT_CLEANUP_PENDING');}
      }
      try{this.db.exec("INSERT INTO chunk_fts(chunk_fts) VALUES('optimize');");}catch{errors.push('FTS_CLEANUP_PENDING');}
      try {
        const target=revocationsPath(this.config);mkdirSync(dirname(target),{recursive:true,mode:0o700});
        const tombstones=this.revocationRows();
        try {if(!revocationSubset(readRevocations(target),tombstones))throw new MemoryError('LATEST_REVOCATIONS_REQUIRED');}
        catch(error:any){if(error.code!=='ENOENT')throw error;}
        writeFileSync(target+'.tmp',tombstones.map(t=>JSON.stringify(t)).join('\n')+'\n',{mode:0o600,flush:true});renameSync(target+'.tmp',target);
        this.db.prepare("INSERT OR REPLACE INTO meta VALUES('revocations_pending',0)").run();
      }catch{errors.push('REVOCATIONS_UNSYNCED_RESTORE_FORBIDDEN');}
      try {syncMaintenance(this.db,this.config);}
      catch {errors.push('MAINTENANCE_UNSYNCED_RESTORE_FORBIDDEN');}
    });
    try{const checkpoint=this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as any;if(checkpoint.busy || checkpoint.log>0)errors.push('WAL_CLEANUP_PENDING');}catch{errors.push('WAL_CLEANUP_PENDING');}
    const cacheGeneration=Number(this.db.prepare("SELECT value FROM meta WHERE key='cache_erasure_before'").get()?.value??0);
    if(cacheGeneration)try {
      const state=QueryState.open(this.db,this.config);
      if(!state.purgeBefore(cacheGeneration))errors.push('CACHE_CLEANUP_PENDING');
    }catch {errors.push('CACHE_CLEANUP_PENDING');}
    return {managed_exports_pending:Number(this.db.prepare("SELECT count(*) AS n FROM exports WHERE status IN ('pending_cleanup','pending_write')").get()!.n),
      revocations_synced:!errors.includes('REVOCATIONS_UNSYNCED_RESTORE_FORBIDDEN'),
      maintenance_synced:!errors.includes('MAINTENANCE_UNSYNCED_RESTORE_FORBIDDEN'),
      cache_cleared:!errors.includes('CACHE_CLEANUP_PENDING'),errors:[...new Set(errors)]};
  }
  async discardProposal(id:string) {
    this.permission('manage');return this.storage.transaction(()=>{
      const p=this.db.prepare('SELECT * FROM proposals WHERE id=?').get(id) as any;
      if(!p)throw new MemoryError('PROPOSAL_NOT_FOUND');this.scope(p.project_id,p.scope);
      this.clearProposal(id,'discarded');
      return {discarded:id};
    });
  }
  retentionCandidates() {
    this.permission('manage');
    return this.snapshot(()=>{
      const canRead=(owner:Ownership)=>owner.scope==='global'?this.config.allow_global:
        this.config.all_projects||this.config.allowed_projects.includes(owner.project_id!);
      const pending=(this.db.prepare(`SELECT id,project_id,scope,connection_id,created_at,expires_at FROM proposals
        WHERE status='pending' ORDER BY expires_at,id`).all() as (Ownership&{expires_at:string})[]).filter(canRead);
      const threshold=cutoff(Math.max(this.config.retention.history_days,this.config.retention.recovery_days));
      const history=(this.db.prepare(`SELECT m.id,m.revision,m.scope,m.project_id,s.lifecycle,m.verified_at
        FROM memory_search s JOIN memories m ON m.id=s.memory_id
        WHERE s.lifecycle IN ('historical','quarantined') AND m.verified_at<? ORDER BY m.verified_at,m.id`).all(threshold) as unknown as
        (Ownership&{id:string;revision:number})[]).filter(canRead)
        .map(row=>({...row,reason:pinned(this.db,row.id,null)?'referenced':null}));
      const versions=(this.db.prepare(`SELECT v.memory_id,v.revision,m.scope,m.project_id
        FROM memory_versions v JOIN memories m ON m.id=v.memory_id
        WHERE v.body_state='stored' AND v.recorded_at<? ORDER BY v.recorded_at,v.memory_id,v.revision`).all(threshold) as unknown as
        (Ownership&{memory_id:string;revision:number})[]).filter(canRead)
        .map(row=>versionCandidate(this.db,row.memory_id,row.revision,this.config.retention));
      return {dry_run:true,policy:this.config.retention,pending:pending.map(p=>({...p,expired:p.expires_at<=now()})),history,versions};
    });
  }
  private retireRecord(action:Extract<RecoveryAction,{kind:'retire'}>) {
    const {record,ownership,reason,replacement,recorded_at}=action;
    const row=this.find(record.memory_id);
    if(row.revision!==record.revision||row.content_hash!==record.content_hash||!sameOwnership(row,ownership)||
      pinned(this.db,row.id,null))throw new MemoryError('RETIRE_VERSION_CONFLICT');
    if(replacement) {
      const survivor=this.find(replacement.memory_id);
      if(survivor.revision!==replacement.revision||survivor.content_hash!==replacement.content_hash||
        !sameOwnership(row,survivor)||survivor.status!=='active')throw new MemoryError('RETIRE_REPLACEMENT_CONFLICT');
    }
    this.queueExportCleanup([row.id]);
    for(const p of relatedProposals(this.db,[row.id]))this.clearProposal(p.id,'invalidated');
    this.deleteIndexes(row.id);
    this.db.prepare('DELETE FROM dependencies WHERE child_id=?').run(row.id);
    this.db.prepare('DELETE FROM memories WHERE id=?').run(row.id);
    this.db.prepare('INSERT INTO retired_memories VALUES(?,?,?,?,?,?,?,?)').run(row.id,row.project_id,row.scope,row.revision,
      row.content_hash,reason,replacement?.memory_id??null,recorded_at);
  }
  async retention(raw:unknown,apply=false) {
    this.permission('manage');
    const {plan_hash,...input}=retentionSchema.parse(raw);
    const change=()=>{
      let impact:unknown,blocked=false,action:RecoveryAction|undefined;
      let expireIds:string[]=[];
      let owner:Ownership={scope:'global',project_id:null};
      if(input.action==='expire') {
        if(new Set(input.proposal_ids).size!==input.proposal_ids.length)throw new MemoryError('PLAN_DUPLICATE_ID');
        const select=this.db.prepare('SELECT id,scope,project_id,status,expires_at,connection_id FROM proposals WHERE id=?');
        const proposals=input.proposal_ids.map(id=>{
          const p=select.get(id) as (Ownership&{id:string;status:string;expires_at:string})|undefined;
          if(!p)throw new MemoryError('PROPOSAL_NOT_FOUND');
          this.scope(p.project_id,p.scope);
          return p;
        });
        owner=proposals[0];
        blocked=proposals.some(p=>p.status!=='expired'&&(p.status!=='pending'||p.expires_at>now()));
        expireIds=proposals.filter(p=>p.status==='pending').map(p=>p.id);
        impact=proposals;
      } else if(input.action==='prune') {
        if(new Set(input.versions.map(ref=>ref.memory_id+':'+ref.revision)).size!==input.versions.length)
          throw new MemoryError('PLAN_DUPLICATE_ID');
        const versions=input.versions.map(ref=>{
          const row=this.find(ref.memory_id);
          return {row,candidate:versionCandidate(this.db,row.id,ref.revision,this.config.retention)};
        });
        owner=versions[0].row;
        blocked=versions.some(({candidate})=>candidate.reason!==null&&candidate.reason!=='pruned');
        const eligible=versions.filter(({candidate})=>candidate.reason===null);
        if(eligible.length)action={kind:'prune',versions:eligible.map(({candidate})=>({
          memory_id:candidate.memory_id,revision:candidate.revision,content_hash:candidate.content_hash}))};
        impact=versions.map(({candidate})=>candidate);
      } else {
        const row=this.find(input.record.memory_id),record=JSON.parse(row.body) as MemoryRecord;
        owner=row;
        if(row.revision!==input.record.revision)throw new MemoryError('VERSION_CONFLICT');
        const issues:string[]=[];
        if(pinned(this.db,row.id,null))issues.push('referenced');
        let replacement:ReturnType<typeof versionHead>|undefined;
        if(input.reason==='redundant') {
          if(!input.replacement||input.replacement.memory_id===row.id)throw new MemoryError('RETIRE_REPLACEMENT_REQUIRED');
          const survivor=this.find(input.replacement.memory_id);
          if(survivor.revision!==input.replacement.revision)throw new MemoryError('VERSION_CONFLICT');
          replacement=versionHead(survivor);
          const sources=retainedSourceKeys(this.db,survivor.id);
          if(!sameOwnership(row,survivor)||survivor.status!=='active'||!sameMemoryMaterial(record,JSON.parse(survivor.body)) ||
            [...retainedSourceKeys(this.db,row.id)].some(source=>!sources.has(source)) ||
            this.db.prepare("SELECT 1 FROM memory_versions WHERE memory_id=? AND body_state='pruned' LIMIT 1").get(row.id))
            issues.push('distinct_material');
        } else if(input.replacement)throw new MemoryError('RETIRE_REPLACEMENT_UNEXPECTED');
        else if(!['historical','quarantined'].includes(record.lifecycle??'current') ||
          row.verified_at>=cutoff(Math.max(this.config.retention.history_days,this.config.retention.recovery_days)))issues.push('recovery_window');
        const proposals=relatedProposals(this.db,[row.id]);
        for(const proposal of proposals)this.scope(proposal.project_id,proposal.scope);
        const exports=managedExports(this.db,[row.id]);
        for(const entry of exports)for(const id of JSON.parse(entry.ids) as string[]){
          const owner=this.currentOwner(id);
          if(owner)this.scope(owner.project_id,owner.scope);
        }
        blocked=issues.length>0;
        action={kind:'retire',record:versionHead(row),ownership:{project_id:row.project_id,scope:row.scope},reason:input.reason,
          replacement,recorded_at:now()};
        impact={record:versionHead(row),replacement,issues,proposals:proposals.map(p=>p.id),exports:exports.map(e=>e.id)};
      }
      const digest=this.planHash('retention',input,{impact,policy:this.config.retention});
      if(!apply)return {dry_run:true,action:input.action,impact,blocked,plan_hash:digest};
      if(plan_hash!==digest)throw new MemoryError(plan_hash?'PLAN_STALE':'PLAN_REQUIRED');
      if(blocked)throw new MemoryError('RETENTION_PROTECTED');
      for(const id of expireIds)this.clearProposal(id,'expired');
      if(action) {
        if(action.kind==='retire')this.retireRecord(action);
        if(action.kind==='prune') {
          for(const ref of action.versions)pruneBody(this.db,ref);
          this.queueExportCleanup([...new Set(action.versions.map(ref=>ref.memory_id))]);
        }
        appendAction(this.db,action);
        this.checkpoint('retention:updated');
      }
      const changed=Boolean(expireIds.length||action);
      const generation=changed?this.storage.advance():this.storage.generation();
      if(action)this.db.prepare("INSERT OR REPLACE INTO meta VALUES('cache_erasure_before',?)").run(generation);
      const result={dry_run:false,action:input.action,changed,generation};
      this.receipt(input.request_id,'retention',{...input,plan_hash},owner.project_id,owner.scope,result);
      return result;
    };
    if(!apply)return this.snapshot(change);
    const result=this.storage.transaction(()=>this.event(input.request_id,'retention',{...input,plan_hash})??change());
    this.checkpoint('retention:committed');
    return {...result,maintenance:await this.maintain()};
  }
  inspect() {
    this.permission('manage');
    const projects=(this.db.prepare('SELECT * FROM projects').all() as any[]).filter(p=>this.config.all_projects || this.config.allowed_projects.includes(p.id));
    const counts=this.db.prepare("SELECT scope,project_id,status,count(*) AS count FROM memories GROUP BY scope,project_id,status").all().filter((r:any)=>(r.scope==='global'?this.config.allow_global:this.config.all_projects || this.config.allowed_projects.includes(r.project_id)));
    return {query_cache:this.cache(),schema:this.storage.schema(),generation:this.storage.generation(),projects,counts};
  }
  diagnoseProjects() {
    this.permission('manage');
    const rows=this.db.prepare('SELECT * FROM projects ORDER BY id').all() as Project[];
    return rows.filter(project=>this.config.all_projects||this.config.allowed_projects.includes(project.id))
      .map(project=>({id:project.id,name:project.name,aliases:(JSON.parse(project.aliases) as string[]).map(path=>{
        try {
          const target=realpathSync(path);
          return {path,status:target===path&&statSync(target).isDirectory()?'live':'changed'};
        } catch(error:any){return {path,status:error.code==='ENOENT'||error.code==='ENOTDIR'?'missing':'unavailable'};}
      })}));
  }
  check() {
    this.permission('manage');
    const integrity=this.db.prepare('PRAGMA integrity_check').all();
    const orphan_chunks=this.db.prepare("SELECT count(*) AS n FROM memory_chunks c LEFT JOIN memories m ON m.id=c.memory_id WHERE m.id IS NULL OR m.status!='active' OR m.revision!=c.revision OR m.profile_id!=c.profile_id").get();
    const orphan_vectors=this.db.prepare('SELECT count(*) AS n FROM memory_vec v LEFT JOIN memory_chunks c ON c.id=v.chunk_id WHERE c.id IS NULL').get();
    const missing_vectors=this.db.prepare('SELECT count(*) AS n FROM memory_chunks c LEFT JOIN memory_vec v ON c.id=v.chunk_id WHERE v.chunk_id IS NULL').get();
    const unindexed=this.db.prepare("SELECT count(*) AS n FROM memories m WHERE status='active' AND NOT EXISTS(SELECT 1 FROM memory_chunks c WHERE c.memory_id=m.id)").get();
    const search_mismatch=this.db.prepare(`SELECT count(*) n FROM memories m LEFT JOIN memory_search s ON s.memory_id=m.id
      WHERE s.memory_id IS NULL OR s.revision!=m.revision OR s.status!=m.status OR s.profile_id!=m.profile_id OR s.project_id IS NOT m.project_id OR s.scope!=m.scope OR s.metadata!=json_remove(m.body,'$.content')`).get();
    const projection_mismatch=this.db.prepare(`SELECT count(*) n FROM claim_projection p LEFT JOIN memories m ON m.id=p.memory_id
      WHERE m.id IS NULL OR m.revision<>p.revision OR m.content_hash<>p.content_hash OR m.status<>'active'`).get();
    const missing_chunk_fts=this.db.prepare("SELECT count(*) n FROM memory_chunks c JOIN memories m ON m.id=c.memory_id WHERE m.status='active' AND NOT EXISTS(SELECT 1 FROM chunk_fts f WHERE f.chunk_id=c.id AND f.memory_id=c.memory_id)").get();
    const orphan_chunk_fts=this.db.prepare('SELECT count(*) n FROM chunk_fts f LEFT JOIN memory_chunks c ON c.id=f.chunk_id WHERE c.id IS NULL OR c.memory_id!=f.memory_id').get();
    const orphan_identifiers=this.db.prepare('SELECT count(*) n FROM chunk_identifiers i LEFT JOIN memory_chunks c ON c.id=i.chunk_id WHERE c.id IS NULL OR c.memory_id!=i.memory_id').get();
    const version_mismatch=this.db.prepare(`SELECT count(*) n FROM memories m LEFT JOIN memory_version_bodies v ON v.memory_id=m.id AND v.revision=m.revision
      WHERE v.memory_id IS NULL OR v.body IS NOT m.body OR v.content_hash<>m.content_hash OR v.written_by<>m.written_by OR v.recorded_at<>m.verified_at`).get();
    const invalid_versions=this.db.prepare(`SELECT count(*) n FROM memory_versions v LEFT JOIN memories m ON m.id=v.memory_id
      WHERE m.id IS NULL OR v.revision>m.revision OR (v.revision=m.revision)<>(v.body_state='head')
        OR (v.body_state='stored')<>(v.body<>'') OR (v.body_state='pruned')<>(v.pruned_context IS NOT NULL)
        OR (v.body_state='pruned' AND NOT json_valid(v.pruned_context))
        OR EXISTS(SELECT 1 FROM tombstones t WHERE t.id=v.memory_id)
        OR EXISTS(SELECT 1 FROM retired_memories t WHERE t.id=v.memory_id)`).get();
    const vector_scope_errors=this.db.prepare(`SELECT count(*) n FROM memory_vec v JOIN memory_chunks c ON c.id=v.chunk_id
      JOIN memories m ON m.id=c.memory_id WHERE v.project_scope IS NOT coalesce(m.project_id,'global')`).get();
    const version_gaps=this.db.prepare(`SELECT count(*) n FROM (
      SELECT memory_id FROM memory_versions GROUP BY memory_id HAVING count(*)<>max(revision)-min(revision)+1)`).get();
    const missing_version_dependencies=this.db.prepare(`SELECT count(*) n FROM (
      SELECT json_extract(d.value,'$.memory_id'),v.memory_id,v.revision FROM memory_version_bodies v,json_each(v.body,'$.derived_from') d
      EXCEPT SELECT parent_id,child_id,child_revision FROM version_dependencies)`).get();
    const relation_scope_errors=this.db.prepare(`SELECT count(*) n FROM memory_relations e
      LEFT JOIN memories a ON a.id=e.from_id LEFT JOIN memories b ON b.id=e.to_id
      WHERE a.id IS NULL OR b.id IS NULL OR a.scope<>e.scope OR b.scope<>e.scope
        OR a.project_id IS NOT e.project_id OR b.project_id IS NOT e.project_id`).get();
    let version_hash_errors=0;
    for(const row of this.db.prepare("SELECT body,content_hash FROM memory_version_bodies WHERE body_state<>'pruned'").iterate()) {
      try { if(recordHash(JSON.parse(String(row.body)))!==row.content_hash)version_hash_errors++; }
      catch { version_hash_errors++; }
    }
    return {integrity,orphan_chunks,orphan_vectors,missing_vectors,unindexed,search_mismatch,projection_mismatch,missing_chunk_fts,orphan_chunk_fts,orphan_identifiers,
      version_mismatch,invalid_versions,version_gaps,missing_version_dependencies,version_hash_errors:{n:version_hash_errors},relation_scope_errors,vector_scope_errors};
  }
  private archivedVersions(id:string) {
    return this.db.prepare('SELECT revision,body,content_hash,recorded_at,profile_id,written_by,body_state,pruned_context FROM memory_version_bodies WHERE memory_id=? ORDER BY revision')
      .all(id).map(({body,pruned_context,...version})=>{
        if(version.body_state!=='pruned')return {...version,body};
        return {...version,pruned_context:JSON.parse(String(pruned_context)),
          aliases:this.db.prepare('SELECT kind,value FROM version_aliases WHERE memory_id=? AND revision=? ORDER BY kind,value').all(id,version.revision),
          dependencies:this.db.prepare(`SELECT parent_id memory_id,parent_revision revision FROM version_dependencies
            WHERE child_id=? AND child_revision=? ORDER BY parent_id`).all(id,version.revision)};
      });
  }
  selectImportMaintenance(raw:unknown) {
    this.permission('manage');
    this.importMaintenance=parseMaintenance(raw);
    this.revocationsChecked=false;
  }
  private importGuards(id:string,owner:Ownership,revision:number,versions:{revision:number;content_hash:string;body_state:string}[]) {
    const local=currentMaintenance(this.db).entries;
    const actions=[...local,...(this.importMaintenance?.entries??[])].map(e=>e.action);
    let destination:Extract<RecoveryAction,{kind:'reassign'}>['destination']|undefined;
    let minimum=0;
    for(const action of actions) {
      if(action.kind==='retire'&&action.record.memory_id===id)return 'blocked_retired';
      if(action.kind==='reassign') {
        const record=action.records.find(r=>r.memory_id===id);
        if(record&&record.revision+1>=minimum) {
          destination=action.destination;
          minimum=record.revision+1;
        }
      }
      if(action.kind==='supersede') {
        const previous=action.predecessors.find(r=>r.memory_id===id);
        if(previous&&revision<=previous.revision)return 'blocked_superseded';
      }
      if(action.kind==='prune'&&action.versions.some(ref=>ref.memory_id===id&&versions.some(v=>
        v.revision===ref.revision&&(v.body_state!=='pruned'||v.content_hash!==ref.content_hash))))return 'blocked_pruned';
    }
    if(destination&&(revision<minimum||!sameOwnership(destination,owner)))return 'blocked_reassigned';
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
    this.scope(latest.project_id,latest.scope);
    const current=this.db.prepare('SELECT * FROM memories WHERE id=?').get(entry.id) as Row|undefined;
    if(current)this.scope(current.project_id,current.scope);
    if(this.isRetired(entry.id))return 'blocked_retired';
    for(const {record,version} of entry.decoded) {
      this.sourceCheck(record);
      if(entry.format===LEGACY_VERSION_ARCHIVE&&!sameOwnership(record,latest))throw new MemoryError('SCOPE_IMMUTABLE');
      if(record.verification.status==='verified') {
        this.permission('verify');
        if(['source_claim','model_inference'].includes(record.verification.basis) || !record.verification.evidence)
          throw new MemoryError('VERIFICATION_EVIDENCE_REQUIRED');
      }
      if(this.isRevoked(entry.id,record.import_key,[version.content_hash],record.sources))return 'blocked_revoked';
    }
    for(const version of entry.versions)if(version.body_state==='pruned') {
      const keys=version.aliases.filter(a=>a.kind==='import_key');
      const sources=version.aliases.filter(a=>a.kind==='source_hash').map(a=>({source_hash:a.value}));
      if(this.isRevoked(entry.id,undefined,[version.content_hash],sources)||
        keys.some(a=>this.isRevoked(entry.id,a.value,[])))return 'blocked_revoked';
    }
    const guard=this.importGuards(entry.id,latest,entry.latest.version.revision,entry.versions);
    if(guard)return guard;
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
        const insert=this.db.prepare(`INSERT INTO memory_versions(memory_id,revision,body,content_hash,recorded_at,profile_id,written_by,body_state,pruned_context)
          VALUES(?,?,?,?,?,?,?,?,?)`);
        for(const v of entry.versions) {
          insert.run(entry.id,v.revision,v.body_state==='stored'?v.body:'',v.content_hash,v.recorded_at,v.profile_id,v.written_by,
            v.body_state,v.body_state==='pruned'?JSON.stringify(v.pruned_context):null);
          if(v.body_state==='pruned') {
            for(const a of v.aliases)this.db.prepare('INSERT INTO version_aliases VALUES(?,?,?,?)').run(entry.id,v.revision,a.kind,a.value);
            for(const d of v.dependencies)this.db.prepare(`INSERT INTO version_dependencies(parent_id,child_id,child_revision,parent_revision)
              VALUES(?,?,?,?)`).run(d.memory_id,entry.id,v.revision,d.revision);
          }
        }
        for(const d of record.derived_from)this.db.prepare('INSERT INTO dependencies VALUES(?,?,?)').run(entry.id,d.memory_id,d.revision);
        const chunks=encoded.get(entry.id);
        if(chunks)this.indexChunks(entry.id,version.revision,profile.id,record,chunks);
      }
      const matchingRevision=ownershipAdvances(this.db,[...(this.importMaintenance?.entries??[]),...currentMaintenance(this.db).entries].map(e=>e.action));
      for(const entry of pending) {
        this.dependencies(entry.latest.record,entry.id,entry.status==='invalidated',matchingRevision);
        if(entry.status==='active')this.validateConsolidation(entry.latest.record,undefined,matchingRevision);
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
      this.db.exec('DELETE FROM memory_vec; DELETE FROM memory_chunks;');
      this.db.prepare('INSERT OR IGNORE INTO embedding_profiles VALUES(?,?)').run(profile.id,JSON.stringify(profile.manifest));
      for(const {row,chunks} of encoded) {
        const body=JSON.parse(row.body);
        this.db.prepare('UPDATE memories SET profile_id=? WHERE id=?').run(profile.id,row.id);
        this.indexChunks(row.id,row.revision,profile.id,body,chunks);
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
    const guard=entry.id?this.importGuards(entry.id,record,entry.revision??0,[{revision:entry.revision,body_state:'stored',content_hash:entry.content_hash}]):undefined;
    let action=this.isRetired(entry.id??'')?'blocked_retired':revoked?'blocked_revoked':guard??(existing?(existing.content_hash===recordHash(normalized)?'unchanged':'update'):'create');
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
  private replaySupersession(action:Extract<RecoveryAction,{kind:'supersede'}>,erased:Set<string>) {
    const {successor,previous_successor,identity,cutoff,recorded_at,written_by}=action;
    const successorErased=erased.has(successor.memory_id);
    const row=successorErased?undefined:this.find(successor.memory_id);
    const known=(id:string,revision:number)=>this.db.prepare('SELECT content_hash,body FROM memory_version_bodies WHERE memory_id=? AND revision=?').get(id,revision);
    const current=known(successor.memory_id,successor.revision);
    let body:MemoryRecord|undefined;
    let update=false;
    if(!successorErased) {
      if(current?.content_hash===successor.content_hash&&current.body)body=JSON.parse(String(current.body));
      else if(row&&previous_successor&&row.revision===previous_successor.revision&&row.content_hash===previous_successor.content_hash) {
        const prior=JSON.parse(row.body) as MemoryRecord;
        body=recordSchema.parse({...prior,...identity,valid_time:{...prior.valid_time,valid_from:cutoff}});
        if(recordHash(body)!==successor.content_hash)throw new MemoryError('RECOVERY_RECONCILIATION_REQUIRED');
        update=true;
      } else throw new MemoryError('RECOVERY_RECONCILIATION_REQUIRED');
    }
    const sourceIndex=new Map<string,MemoryRecord['sources'][number]>();
    const remember=(record:MemoryRecord)=>{for(const source of record.sources)sourceIndex.set(hash(source),source);};
    if(body)remember(body);
    for(const prior of action.predecessors) {
      if(erased.has(prior.memory_id))continue;
      const original=this.find(prior.memory_id);
      const already=known(prior.memory_id,prior.revision+1);
      if(already?.content_hash===prior.next_hash) {
        if(already.body)remember(JSON.parse(String(already.body)));
        continue;
      }
      if(original.revision!==prior.revision||original.content_hash!==prior.content_hash)
        throw new MemoryError('RECOVERY_RECONCILIATION_REQUIRED');
      remember(JSON.parse(original.body));
      const closed=this.supersede(original,cutoff,recorded_at,written_by,identity);
      if(closed.next_hash!==prior.next_hash)throw new MemoryError('RECOVERY_RECONCILIATION_REQUIRED');
    }
    if(update&&row&&body) {
      this.invalidate(this.descendants(row.id),false);
      this.db.prepare('UPDATE memories SET body=?,revision=?,verified_at=?,written_by=?,content_hash=? WHERE id=?')
        .run(JSON.stringify(body),successor.revision,recorded_at,written_by,successor.content_hash,row.id);
      this.db.prepare('UPDATE memory_chunks SET revision=? WHERE memory_id=?').run(successor.revision,row.id);
    }
    for(const relation of action.relations) {
      if(erased.has(relation.from.memory_id)||erased.has(relation.to.memory_id))continue;
      if(this.db.prepare('SELECT 1 FROM memory_relations WHERE id=?').get(relation.id))continue;
      const from=this.find(relation.from.memory_id),to=this.find(relation.to.memory_id);
      const evidence=known(to.id,relation.to.revision);
      if(evidence?.body)remember(JSON.parse(String(evidence.body)));
      const sources=relation.source_signatures.map(digest=>sourceIndex.get(digest));
      if(sources.some(source=>!source)||!sameOwnership(from,to))throw new MemoryError('RECOVERY_RECONCILIATION_REQUIRED');
      this.db.prepare('INSERT INTO memory_relations VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(relation.id,1,from.id,relation.from.revision,
        to.id,relation.to.revision,relation.type,from.project_id,from.scope,JSON.stringify(sources),recorded_at);
    }
    this.db.exec("UPDATE meta SET value=value+1 WHERE key='graph_epoch'");
  }
  async recover(raw:unknown,revocations:any[]) {
    if(!this.config.operations.includes('manage')||!this.config.all_projects||!this.config.allow_global||
      !this.db.prepare("SELECT value FROM meta WHERE key='recovery_pending'").get()?.value)
      throw new MemoryError('RECOVERY_STAGE_REQUIRED');
    const ledger=parseMaintenance(raw);
    const erased=new Set<string>(revocations.map(t=>t.id));
    this.recoveryMode=true;
    try {
      this.storage.transaction(()=>{
        const local=currentMaintenance(this.db);
        if(!prefixOf(local,ledger))throw new MemoryError('LATEST_MAINTENANCE_REQUIRED');
        // This staged database is a file-level backup without its original managed exports.
        this.db.exec('DELETE FROM exports');
        for(const {id,action} of ledger.entries.slice(local.entries.length)) {
          if(action.kind==='project') {
            const project=this.db.prepare('SELECT * FROM projects WHERE id=?').get(action.project_id) as Project|undefined;
            const prior=project?JSON.parse(project.aliases):null;
            if(hash(prior)!==hash(action.previous))throw new MemoryError('RECOVERY_RECONCILIATION_REQUIRED');
            this.checkAliasCollision(action.project_id,action.aliases);
            this.saveAliases(action);
          } else if(action.kind==='reassign') {
            this.scope(action.destination.project_id,action.destination.scope);
            const impact=ownershipImpact(this.db,action.records.map(r=>r.memory_id),action.destination,owner=>this.scope(owner.project_id,owner.scope));
            if(impact.blocked.length)throw new MemoryError('RECOVERY_RECONCILIATION_REQUIRED');
            this.moveRecords(action);
          } else if(action.kind==='retire')this.retireRecord(action);
          else if(action.kind==='prune') {
            for(const ref of action.versions)if(!erased.has(ref.memory_id))pruneBody(this.db,ref);
          } else this.replaySupersession(action,erased);
          appendAction(this.db,action,id);
          this.checkpoint('recovery:action');
        }
        if(local.entries.length!==ledger.entries.length)this.storage.advance();
      });
      await this.applyRevocations(revocations);
      const maintenance=await this.maintain();
      if(maintenance.errors.length)throw new MemoryError('RECOVERY_CLEANUP_PENDING');
      const check=this.check();
      if(check.integrity.length!==1||check.integrity[0].integrity_check!=='ok'||
        Object.values(check).some(value=>value&&'n' in value&&value.n!==0)||
        this.db.prepare('PRAGMA foreign_key_check').all().length)throw new MemoryError('RECOVERY_INTEGRITY_FAILED');
      this.storage.transaction(()=>this.db.exec("UPDATE meta SET value=0 WHERE key='recovery_pending'"));
      return {recovered:true,schema:this.storage.schema(),generation:this.storage.generation(),maintenance,check};
    } finally {this.recoveryMode=false;}
  }
  async applyRevocations(entries:any[]) {
    this.permission('manage');this.revocationsChecked=false;
    const result=this.storage.transaction(()=>{
      const changes=Number(this.db.prepare('SELECT total_changes() n').get()!.n);
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
        for(const hash of new Set(versionHashes))
          this.db.prepare('INSERT OR IGNORE INTO revoked_version_hashes VALUES(?,?)').run(t.id,hash);
        const alias=this.db.prepare('INSERT OR IGNORE INTO revoked_aliases VALUES(?,?,?)');
        const headKey=this.db.prepare('SELECT import_key FROM tombstones WHERE id=?').get(t.id)?.import_key;
        for(const value of new Set([...importKeys,...(t.import_key==null||t.import_key===headKey?[]:[t.import_key])]))
          alias.run(t.id,'import_key',value);
        for(const value of sourceHashes)alias.run(t.id,'source_hash',value);
        for(const id of erasureTree(this.db,t.id))erase.add(id);
        const copies=this.db.prepare(`SELECT DISTINCT v.memory_id FROM memory_versions v JOIN memories m ON m.id=v.memory_id
          WHERE m.scope=? AND m.project_id IS ? AND v.content_hash IN (SELECT value FROM json_each(?))`).all(t.scope,t.project_id,JSON.stringify(hashes));
        for(const copy of copies)for(const id of erasureTree(this.db,String(copy.memory_id)))erase.add(id);
      }
      const ids=[...erase].filter(id=>Boolean(this.db.prepare('SELECT 1 FROM memories WHERE id=?').get(id)));
      for(const id of ids)this.find(id);
      for(const p of this.eraseProposals([...erase],[],[],[])){
        this.scope(p.project_id,p.scope);
        this.clearProposal(p.id,'invalidated');
      }
      if(ids.length)this.invalidate(ids,true);
      for(const entry of this.db.prepare("SELECT id,ids FROM exports WHERE status!='removed'").all() as {id:string;ids:string}[]) {
        if((JSON.parse(entry.ids) as string[]).some(id=>erase.has(id)||this.db.prepare('SELECT 1 FROM tombstones WHERE id=?').get(id)))
          this.db.prepare("UPDATE exports SET status='pending_cleanup' WHERE id=?").run(entry.id);
      }
      const changed=Number(this.db.prepare('SELECT total_changes() n').get()!.n)!==changes;
      this.db.prepare("INSERT OR REPLACE INTO meta VALUES('revocations_pending',1)").run();
      const generation=changed?this.storage.advance():this.storage.generation();
      if(changed)this.db.prepare("INSERT OR REPLACE INTO meta VALUES('cache_erasure_before',?)").run(generation);
      return {revocations_applied:entries.length,generation};
    });
    const maintenance=await this.maintain();
    if(!maintenance.revocations_synced)throw new MemoryError('REVOCATIONS_UNSYNCED_RESTORE_FORBIDDEN');
    if(!maintenance.maintenance_synced)throw new MemoryError('MAINTENANCE_UNSYNCED_RESTORE_FORBIDDEN');
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
