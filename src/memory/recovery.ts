import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {hash,MemoryError,ownershipSchema,planHashSchema,relationTypeSchema,versionRefSchema,type Config} from '../core/contracts.js';

const head=versionRefSchema.extend({content_hash:planHashSchema});
const time=z.string().datetime();
const aliases=z.array(z.string().startsWith('/').max(4096)).max(64);
const identity=z.object({subject_id:z.string().min(1).max(256),context_key:z.string().min(1).max(256)}).strict();
const actionSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('project'),project_id:z.string().uuid(),name:z.string(),previous:aliases.nullable(),aliases}).strict(),
  z.object({kind:z.literal('reassign'),destination:ownershipSchema,records:z.array(head.extend({
    previous:ownershipSchema, next_hash:planHashSchema
  })).min(1).max(64),written_by:z.string(),recorded_at:time}).strict(),
  z.object({kind:z.literal('supersede'),successor:head,predecessors:z.array(head.extend({next_hash:planHashSchema})).min(1).max(10),
    previous_successor:head.optional(),identity:identity.optional(),cutoff:time,recorded_at:time,written_by:z.string(),
    relations:z.array(z.object({id:z.string().uuid(),type:relationTypeSchema,from:versionRefSchema,to:versionRefSchema,
      source_signatures:z.array(planHashSchema).min(1).max(12)}).strict()).max(20)}).strict(),
  z.object({kind:z.literal('retire'),record:head,ownership:ownershipSchema,reason:z.enum(['redundant','expired_history']),
    replacement:head.optional(),recorded_at:time}).strict(),
  z.object({kind:z.literal('prune'),versions:z.array(head).min(1).max(100)}).strict()
]);
const entrySchema=z.object({id:z.string().uuid(),action:actionSchema}).strict();
const ledgerSchema=z.object({format:z.literal('shared-agent-memory/maintenance-v1'),entries:z.array(entrySchema)}).strict()
  .refine(x=>new Set(x.entries.map(e=>e.id)).size===x.entries.length,'maintenance IDs must be unique');
export type RecoveryAction=z.infer<typeof actionSchema>;
export type MaintenanceLedger=z.infer<typeof ledgerSchema>;

export function migrateMaintenance(db:DatabaseSync) {
  db.exec(`
    CREATE TABLE maintenance_actions(seq INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,action TEXT NOT NULL);
    INSERT INTO meta VALUES('maintenance_pending',0),('recovery_pending',0);
    CREATE TABLE retired_memories(
      id TEXT PRIMARY KEY,project_id TEXT,scope TEXT NOT NULL,revision INTEGER NOT NULL,content_hash TEXT NOT NULL,
      reason TEXT NOT NULL,replacement_id TEXT,recorded_at TEXT NOT NULL
    );
  `);
}

export function maintenancePath(config:Config) {
  return join(config.maintenance_state??dirname(config.database),'maintenance.json');
}
export function revocationsPath(config:Config) {
  return join(config.maintenance_state??dirname(config.database),'revocations.jsonl');
}

export function parseMaintenance(raw:unknown):MaintenanceLedger {
  return ledgerSchema.parse(raw);
}
export function readMaintenance(path:string) {
  return parseMaintenance(JSON.parse(readFileSync(path,'utf8')));
}
export function readRevocations(path:string) {
  return readFileSync(path,'utf8').split('\n').filter(s=>s.trim()).map(s=>JSON.parse(s));
}
export function revocationSubset(previous:any[],next:any[]) {
  const index=new Map(next.map(row=>[row.id,row]));
  return previous.every(row=>{
    const current=index.get(row.id);
    return current && ['scope','project_id','content_hash','revision'].every(k=>row[k]===current[k]) &&
      ['version_hashes','source_hashes','import_keys'].every(k=>(row[k]??[]).every((value:string)=>(current[k]??[]).includes(value)));
  });
}

export function currentMaintenance(db:DatabaseSync):MaintenanceLedger {
  const entries=db.prepare('SELECT id,action FROM maintenance_actions ORDER BY seq').all()
    .map(({id,action})=>({id:String(id),action:JSON.parse(String(action))}));
  return {format:'shared-agent-memory/maintenance-v1',entries};
}

export function appendAction(db:DatabaseSync,action:RecoveryAction,id:string=randomUUID()) {
  db.prepare('INSERT INTO maintenance_actions(id,action) VALUES(?,?)').run(id,JSON.stringify(actionSchema.parse(action)));
  db.exec("UPDATE meta SET value=1 WHERE key='maintenance_pending'");
}

export function prefixOf(base:MaintenanceLedger,next:MaintenanceLedger) {
  return base.entries.length<=next.entries.length && base.entries.every((e,i)=>hash(e)===hash(next.entries[i]));
}

export function syncMaintenance(db:DatabaseSync,config:Config) {
  const target=maintenancePath(config),latest=currentMaintenance(db);
  let existing:MaintenanceLedger|undefined;
  try {existing=readMaintenance(target);}
  catch(error:any) {if(error.code!=='ENOENT')throw new MemoryError('MAINTENANCE_UNSYNCED_RESTORE_FORBIDDEN');}
  if(existing&&!prefixOf(existing,latest))throw new MemoryError('LATEST_MAINTENANCE_REQUIRED');
  if(!existing||existing.entries.length!==latest.entries.length) {
    mkdirSync(dirname(target),{mode:0o700,recursive:true});
    const pending=target+'.'+randomUUID()+'.tmp';
    try {
      writeFileSync(pending,JSON.stringify(latest)+'\n',{mode:0o600,flag:'wx',flush:true});
      renameSync(pending,target);
    } finally {
      try {unlinkSync(pending);}catch(error:any){if(error.code!=='ENOENT')throw error;}
    }
  }
  db.exec("UPDATE meta SET value=0 WHERE key='maintenance_pending'");
}
