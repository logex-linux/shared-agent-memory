import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { MemoryError } from '../core/contracts.js';
import { migrateSearch } from '../retrieval/indexes.js';
import { migrateVersions } from '../memory/versions.js';
import { migrateRelations } from '../memory/transitions.js';
import { migrateGraph } from '../retrieval/graph.js';
import { migrateErasure } from '../memory/erasure.js';
import { indexAssociationWalk, migrateFeedback } from '../memory/feedback.js';

export const SCHEMA_VERSION = 10;

export class Storage {
  db: DatabaseSync;
  constructor(path:string, checkpoint:(point:string)=>void=()=>{}) {
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path,{allowExtension:true});
    try {
      chmodSync(path,0o600);
      sqliteVec.load(this.db);
      this.db.enableLoadExtension(false);
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;');
      const version=this.schema();
      if (version>SCHEMA_VERSION) throw new MemoryError('SCHEMA_TOO_NEW');
      if (version<SCHEMA_VERSION) {
        this.transaction(()=>{
          this.migrate(this.schema());
          checkpoint('migration:before_commit');
        });
        checkpoint('migration:after_commit');
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  schema() { return Number(this.db.prepare('PRAGMA user_version').get()!.user_version); }
  private migrate(version:number) {
    if (version>SCHEMA_VERSION) throw new MemoryError('SCHEMA_TOO_NEW');
    if (version===0) this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,aliases TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES('generation',0);
      CREATE TABLE IF NOT EXISTS embedding_profiles(id TEXT PRIMARY KEY,manifest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(
        id TEXT PRIMARY KEY,project_id TEXT,scope TEXT NOT NULL,body TEXT NOT NULL,
        revision INTEGER NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,verified_at TEXT NOT NULL,
        profile_id TEXT NOT NULL,content_hash TEXT NOT NULL,import_key TEXT UNIQUE
      );
      CREATE INDEX IF NOT EXISTS memories_scope ON memories(project_id,scope,status);
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,project_id TEXT,scope TEXT NOT NULL,body TEXT,
        target_id TEXT,expected_revision INTEGER NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dependencies(child_id TEXT NOT NULL,parent_id TEXT NOT NULL,parent_revision INTEGER NOT NULL,
        PRIMARY KEY(child_id,parent_id));
      CREATE INDEX IF NOT EXISTS dependency_parent ON dependencies(parent_id);
      CREATE TABLE IF NOT EXISTS events(request_id TEXT PRIMARY KEY,operation TEXT NOT NULL,request_hash TEXT NOT NULL,
        project_id TEXT,scope TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tombstones(id TEXT PRIMARY KEY,project_id TEXT,scope TEXT NOT NULL,revision INTEGER NOT NULL,
        import_key TEXT,content_hash TEXT NOT NULL,forgotten_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_chunks(id INTEGER PRIMARY KEY,memory_id TEXT NOT NULL,revision INTEGER NOT NULL,
        start INTEGER NOT NULL,end INTEGER NOT NULL,tokens INTEGER NOT NULL,text TEXT NOT NULL,profile_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chunks_memory ON memory_chunks(memory_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(memory_id UNINDEXED,terms,tokenize='unicode61');
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(chunk_id INTEGER PRIMARY KEY,embedding FLOAT[512],project_scope TEXT);
      CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY,path TEXT NOT NULL,ids TEXT NOT NULL,status TEXT NOT NULL);
      PRAGMA user_version=1;
    `);
    if(version<2)this.db.exec('CREATE TABLE IF NOT EXISTS import_targets(proposal_id TEXT PRIMARY KEY,memory_id TEXT NOT NULL,revision INTEGER NOT NULL); PRAGMA user_version=2;');
    if(version<3)this.db.exec("INSERT INTO memories_fts(memories_fts,rank) VALUES('secure-delete',1); PRAGMA user_version=3;");
    if(version<4){
      this.db.exec(`
      ALTER TABLE memories ADD COLUMN written_by TEXT NOT NULL DEFAULT 'legacy:unknown';
      ALTER TABLE proposals ADD COLUMN connection_id TEXT NOT NULL DEFAULT 'legacy:unknown';
      ALTER TABLE events ADD COLUMN connection_id TEXT NOT NULL DEFAULT 'legacy:unknown';
      PRAGMA user_version=4;
    `);}
    if(version<5){
      migrateSearch(this.db);this.db.exec('PRAGMA user_version=5;');
    }
    if(version<6){
      migrateVersions(this.db);
      this.db.exec('PRAGMA user_version=6;');
    }
    if(version<7){
      migrateRelations(this.db);
      this.db.exec('PRAGMA user_version=7;');
    }
    if(version<8){
      migrateGraph(this.db);
      this.db.exec('PRAGMA user_version=8;');
    }
    if(version<9){
      migrateFeedback(this.db);
      this.db.exec('PRAGMA user_version=9;');
    }
    if(version<10){
      migrateErasure(this.db);
      indexAssociationWalk(this.db);
      this.db.exec('PRAGMA user_version=10;');
    }
  }
  transaction<T>(fn:()=>T):T {
    try {
      // BEGIN IMMEDIATE reserves every attached database, even when only main is
      // written. A warmed recall connection must not reserve the sidecar writer.
      if((this.db.prepare('PRAGMA database_list').all() as any[]).some(r=>r.name==='retrieval_state'))
        this.db.exec('DETACH DATABASE retrieval_state');
      this.db.exec('BEGIN IMMEDIATE');
      try { const result=fn(); this.db.exec('COMMIT'); return result; }
      catch(error) { this.db.exec('ROLLBACK'); throw error; }
    } catch(error:any) {
      if (error.code==='ERR_SQLITE_ERROR' && /locked|busy/i.test(error.message)) throw new MemoryError('BUSY_RETRYABLE');
      throw error;
    }
  }
  generation() { return Number((this.db.prepare("SELECT value FROM meta WHERE key='generation'").get() as any).value); }
  advance() { this.db.prepare("UPDATE meta SET value=value+1 WHERE key='generation'").run(); return this.generation(); }
  close() { this.db.close(); }
}
