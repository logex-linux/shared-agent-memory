import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import { hash, MemoryError, type Config, type feedbackSchema } from '../core/contracts.js';

export type Feedback = z.infer<typeof feedbackSchema>;
export const LEARNING_VERSION = 'scoped-outcomes-v1';
const HOUR = 3600000;
const HALF_LIFE = 30*24*HOUR;

export function migrateFeedback(db:DatabaseSync) {
  db.exec(`
    CREATE TABLE learning_events(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE,
      connection_id TEXT NOT NULL, task TEXT NOT NULL, receipt TEXT NOT NULL,
      a TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, a_revision INTEGER NOT NULL,
      b TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, b_revision INTEGER NOT NULL,
      scope TEXT NOT NULL, project_id TEXT, outcome TEXT NOT NULL, basis TEXT NOT NULL,
      evidence_digest TEXT, delta REAL NOT NULL, recorded_ms INTEGER NOT NULL, policy TEXT NOT NULL,
      UNIQUE(connection_id,task,a,b)
    );
    CREATE UNIQUE INDEX learning_task_pair ON learning_events(task,a,b) WHERE delta<>0;
    CREATE INDEX learning_rate ON learning_events(connection_id,recorded_ms);
    CREATE INDEX learning_a ON learning_events(a);
    CREATE INDEX learning_b ON learning_events(b);
    CREATE TABLE projection_jobs(seq INTEGER PRIMARY KEY REFERENCES learning_events(seq) ON DELETE CASCADE);
    CREATE TABLE association_edges(
      a TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, a_revision INTEGER NOT NULL,
      b TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, b_revision INTEGER NOT NULL,
      scope TEXT NOT NULL, project_id TEXT, weight REAL NOT NULL, updated_ms INTEGER NOT NULL,
      last_seq INTEGER NOT NULL, policy TEXT NOT NULL, PRIMARY KEY(a,a_revision,b,b_revision)
    );
    CREATE INDEX association_b ON association_edges(b,b_revision,a,a_revision);
    CREATE TRIGGER remove_feedback_receipt AFTER DELETE ON learning_events BEGIN
      DELETE FROM events WHERE request_id=old.request_id AND operation='feedback';
    END;
    INSERT INTO meta VALUES('learning_watermark',0);
  `);
}

export function recordFeedback(db:DatabaseSync, config:Config, input:Feedback,
  scope:{scope:string;project_id:string|null}) {
  const [a,b=a]=[...input.used].sort((left,right)=>left.memory_id.localeCompare(right.memory_id));
  const task=hash(input.task_id), at=Date.now();
  const qualified=a!==b && config.feedback_policy==='trusted_outcomes' && input.basis!=='agent_report';
  const delta=qualified?(input.outcome==='useful'?0.2:input.outcome==='misleading'?-0.3:-0.1):0;
  if(db.prepare('SELECT 1 FROM learning_events WHERE connection_id=? AND task=? AND a=? AND b=?')
    .get(config.connection_id,task,a.memory_id,b.memory_id) ||
    delta!==0 && db.prepare('SELECT 1 FROM learning_events WHERE task=? AND a=? AND b=? AND delta<>0')
      .get(task,a.memory_id,b.memory_id))return {recorded:false,duplicate:true,projection_queued:false};
  const rate=Number(db.prepare('SELECT count(*) n FROM learning_events WHERE connection_id=? AND recorded_ms>?')
    .get(config.connection_id,at-HOUR)?.n);
  if(rate>=60)throw new MemoryError('FEEDBACK_RATE_LIMIT');
  if(Number(db.prepare('SELECT count(*) n FROM learning_events').get()?.n)>=100000)
    throw new MemoryError('FEEDBACK_CAPACITY');
  const event=db.prepare(`INSERT INTO learning_events(request_id,connection_id,task,receipt,a,a_revision,b,b_revision,
    scope,project_id,outcome,basis,evidence_digest,delta,recorded_ms,policy) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(input.request_id,config.connection_id,task,hash(input.page_receipt),a.memory_id,a.revision,b.memory_id,b.revision,
      scope.scope,scope.project_id,input.outcome,input.basis,input.evidence_ref?hash(input.evidence_ref):null,delta,at,LEARNING_VERSION);
  db.prepare('INSERT INTO projection_jobs VALUES(?)').run(event.lastInsertRowid);
  return {recorded:true,duplicate:false,projection_queued:true,weight_eligible:qualified};
}

export function decayWeight(weight:number, elapsed:number) {
  return weight*Math.exp(-Math.LN2*Math.max(0,elapsed)/HALF_LIFE);
}

export function indexAssociationWalk(db:DatabaseSync) {
  db.exec(`CREATE UNIQUE INDEX association_seq ON association_edges(last_seq);
    CREATE INDEX association_a_walk ON association_edges(a,last_seq);
    CREATE INDEX association_b_walk ON association_edges(b,last_seq);`);
}

export function projectFeedback(db:DatabaseSync, limit:number, rebuild:boolean) {
  if(rebuild) db.exec(`DELETE FROM association_edges; DELETE FROM projection_jobs;
    INSERT INTO projection_jobs SELECT seq FROM learning_events;
    UPDATE meta SET value=0 WHERE key='learning_watermark';`);
  const rows=db.prepare(`SELECT e.* FROM projection_jobs j JOIN learning_events e ON e.seq=j.seq ORDER BY j.seq LIMIT ?`).all(limit);
  const select=db.prepare('SELECT weight,updated_ms FROM association_edges WHERE a=? AND a_revision=? AND b=? AND b_revision=?');
  const save=db.prepare(`INSERT INTO association_edges VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(a,a_revision,b,b_revision) DO UPDATE SET weight=excluded.weight,
      updated_ms=excluded.updated_ms,last_seq=excluded.last_seq,policy=excluded.policy`);
  let changes=0;
  for(const row of rows) {
    if(row.policy!==LEARNING_VERSION)throw new MemoryError('FEEDBACK_POLICY_UNSUPPORTED');
    if(row.delta!==0) {
      const prior=select.get(row.a,row.a_revision,row.b,row.b_revision);
      const weight=Math.max(0,Math.min(1,decayWeight(Number(prior?.weight??0),Number(row.recorded_ms)-Number(prior?.updated_ms??row.recorded_ms))+Number(row.delta)));
      if(weight>0||prior) {
        save.run(row.a,row.a_revision,row.b,row.b_revision,row.scope,row.project_id,weight,row.recorded_ms,row.seq,row.policy);
        changes++;
      }
    }
    db.prepare('DELETE FROM projection_jobs WHERE seq=?').run(row.seq);
  }
  if(rows.length)db.prepare("UPDATE meta SET value=max(value,?) WHERE key='learning_watermark'").run(rows.at(-1)!.seq);
  if(changes||rebuild)db.exec("UPDATE meta SET value=value+1 WHERE key='graph_epoch'");
  return {processed:rows.length,changed_edges:changes,pending:db.prepare('SELECT count(*) n FROM projection_jobs').get()?.n,
    watermark:db.prepare("SELECT value FROM meta WHERE key='learning_watermark'").get()?.value};
}
