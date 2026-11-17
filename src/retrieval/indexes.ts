import type { DatabaseSync } from 'node:sqlite';
import { terms,identifierWeights } from './lexical.js';
import { TEMPORAL_EXCEPTION } from '../memory/temporal.js';

const SEARCH_COLUMNS=`
 memory_id TEXT PRIMARY KEY,project_id TEXT,scope TEXT NOT NULL,revision INTEGER NOT NULL,
 status TEXT NOT NULL,profile_id TEXT NOT NULL,branch TEXT,commit_ref TEXT,environment TEXT,expires_at TEXT,
 metadata TEXT NOT NULL`;
const SEARCH_SCOPE_INDEX='CREATE INDEX IF NOT EXISTS search_scope ON memory_search(scope,project_id,status,profile_id);';
const SEARCH_TRIGGERS=`
CREATE TRIGGER IF NOT EXISTS search_insert AFTER INSERT ON memories BEGIN
 INSERT OR REPLACE INTO memory_search VALUES(new.id,new.project_id,new.scope,new.revision,new.status,new.profile_id,
 json_extract(new.body,'$.valid_for.branch'),json_extract(new.body,'$.valid_for.commit'),
 json_extract(new.body,'$.valid_for.environment'),json_extract(new.body,'$.valid_for.expires_at'),json_remove(new.body,'$.content'));
END;
CREATE TRIGGER IF NOT EXISTS search_update AFTER UPDATE ON memories BEGIN
 UPDATE memory_search SET project_id=new.project_id,scope=new.scope,revision=new.revision,status=new.status,profile_id=new.profile_id,
 branch=json_extract(new.body,'$.valid_for.branch'),commit_ref=json_extract(new.body,'$.valid_for.commit'),
 environment=json_extract(new.body,'$.valid_for.environment'),expires_at=json_extract(new.body,'$.valid_for.expires_at'),metadata=json_remove(new.body,'$.content')
 WHERE memory_id=new.id;
END;
CREATE TRIGGER IF NOT EXISTS search_delete AFTER DELETE ON memories BEGIN
 DELETE FROM memory_search WHERE memory_id=old.id;
END;
`;

// Derived indexes only. The canonical body and its revision are never rewritten here.
export const SEARCH_SCHEMA=`
CREATE TABLE IF NOT EXISTS memory_search(${SEARCH_COLUMNS});
${SEARCH_SCOPE_INDEX}
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(chunk_id UNINDEXED,memory_id UNINDEXED,terms,tokenize='unicode61');
INSERT INTO chunk_fts(chunk_fts,rank) VALUES('secure-delete',1);
CREATE TABLE IF NOT EXISTS chunk_identifiers(
 chunk_id INTEGER NOT NULL,memory_id TEXT NOT NULL,identifier TEXT NOT NULL,weight INTEGER NOT NULL,
 PRIMARY KEY(chunk_id,identifier)
);
CREATE INDEX IF NOT EXISTS identifiers_lookup ON chunk_identifiers(identifier,memory_id);
${SEARCH_TRIGGERS}
CREATE TRIGGER IF NOT EXISTS chunk_search_delete AFTER DELETE ON memory_chunks BEGIN
 DELETE FROM chunk_fts WHERE chunk_id=old.id;
 DELETE FROM chunk_identifiers WHERE chunk_id=old.id;
END;
`;

export function migrateTemporalSearch(db:DatabaseSync) {
  db.exec(`
    CREATE TABLE memory_search_v11(${SEARCH_COLUMNS},
      lifecycle TEXT GENERATED ALWAYS AS (coalesce(json_extract(metadata,'$.lifecycle'),'current')) STORED,
      valid_from_jd REAL GENERATED ALWAYS AS (CASE WHEN json_extract(metadata,'$.valid_time.valid_from') IS NOT NULL
        THEN coalesce(julianday(json_extract(metadata,'$.valid_time.valid_from')),1e12) END) STORED,
      valid_to_jd REAL GENERATED ALWAYS AS (CASE WHEN json_extract(metadata,'$.valid_time.valid_to') IS NOT NULL
        THEN coalesce(julianday(json_extract(metadata,'$.valid_time.valid_to')),-1e12) END) STORED,
      decision_state TEXT GENERATED ALWAYS AS (json_extract(metadata,'$.decision_state')) STORED
    );
    INSERT INTO memory_search_v11 SELECT * FROM memory_search;
    DROP TRIGGER search_insert;
    DROP TRIGGER search_update;
    DROP TRIGGER search_delete;
    DROP TABLE memory_search;
    ALTER TABLE memory_search_v11 RENAME TO memory_search;
    ${SEARCH_SCOPE_INDEX}
    CREATE INDEX search_temporal_exceptions ON memory_search(memory_id) WHERE ${TEMPORAL_EXCEPTION};
    ${SEARCH_TRIGGERS}
  `);
}

export const CURRENT_RULE = "status='active' AND lifecycle='current' AND decision_state='adopted' AND kind IN ('preference','decision') AND length(trim(subject_id))>0 AND length(trim(context_key))>0";

export function migrateSubjects(db:DatabaseSync) {
  db.exec(`
    ALTER TABLE memory_search ADD COLUMN subject_id TEXT GENERATED ALWAYS AS (json_extract(metadata,'$.subject_id')) VIRTUAL;
    ALTER TABLE memory_search ADD COLUMN context_key TEXT GENERATED ALWAYS AS (json_extract(metadata,'$.context_key')) VIRTUAL;
    ALTER TABLE memory_search ADD COLUMN kind TEXT GENERATED ALWAYS AS (json_extract(metadata,'$.kind')) VIRTUAL;
    CREATE INDEX search_subject ON memory_search(subject_id,context_key);
    CREATE INDEX search_current_rules ON memory_search(scope,project_id,subject_id,context_key,environment) WHERE ${CURRENT_RULE};
  `);
  // Existing rows are preserved even if a previous runtime admitted duplicates.
  // New revisions must close conflicting rules within the same SQLite transaction.
  for(const operation of ['INSERT','UPDATE'] as const)db.exec(`
    CREATE TRIGGER current_rule_${operation.toLowerCase()} AFTER ${operation} ON memory_search
    ${operation==='UPDATE'?"WHEN old.revision<>new.revision OR old.scope<>new.scope OR old.project_id IS NOT new.project_id":''}
    BEGIN
      SELECT RAISE(ABORT,'CURRENT_RULE_CONFLICT') WHERE
        (SELECT 1 FROM memory_search WHERE memory_id=new.memory_id AND ${CURRENT_RULE}) AND
        EXISTS(SELECT 1 FROM memory_search WHERE ${CURRENT_RULE} AND scope=new.scope
          AND project_id IS new.project_id AND subject_id=new.subject_id AND context_key=new.context_key
          AND environment IS new.environment AND memory_id<>new.memory_id);
    END;
  `);
}

export function indexChunk(db:DatabaseSync,chunk:{id:number;memory_id:string;text:string},title:string,tags:string[]) {
  db.prepare('INSERT INTO chunk_fts VALUES(?,?,?)').run(chunk.id,chunk.memory_id,terms(title+' '+chunk.text+' '+tags.join(' ')).join(' '));
  const insert=db.prepare('INSERT INTO chunk_identifiers VALUES(?,?,?,?)');
  for(const [identifier,weight]of identifierWeights(title,chunk.text,tags))insert.run(chunk.id,chunk.memory_id,identifier,weight);
}

export function migrateSearch(db:DatabaseSync) {
  db.exec(SEARCH_SCHEMA);
  db.exec(`DELETE FROM memory_search;
  INSERT INTO memory_search SELECT id,project_id,scope,revision,status,profile_id,
   json_extract(body,'$.valid_for.branch'),json_extract(body,'$.valid_for.commit'),
   json_extract(body,'$.valid_for.environment'),json_extract(body,'$.valid_for.expires_at'),json_remove(body,'$.content') FROM memories;
  DELETE FROM chunk_fts; DELETE FROM chunk_identifiers;
  CREATE TABLE vector_migration AS SELECT chunk_id,embedding,project_scope FROM memory_vec;
  DROP TABLE memory_vec;
  CREATE VIRTUAL TABLE memory_vec USING vec0(chunk_id INTEGER PRIMARY KEY,embedding FLOAT[512] distance_metric=cosine,project_scope TEXT);
  INSERT INTO memory_vec SELECT * FROM vector_migration;
  DROP TABLE vector_migration;`);
  let last='',metadata:any;
  for(const row of db.prepare("SELECT c.id,c.memory_id,c.text,s.metadata FROM memory_chunks c JOIN memory_search s ON s.memory_id=c.memory_id WHERE s.status='active' ORDER BY c.memory_id,c.id").iterate() as Iterable<any>) {
    if(last!==row.memory_id){last=row.memory_id;metadata=JSON.parse(row.metadata);}
    indexChunk(db,row,metadata.title,metadata.tags??[]);
  }
}
