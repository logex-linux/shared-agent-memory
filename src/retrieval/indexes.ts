import type { DatabaseSync } from 'node:sqlite';
import { terms,identifierWeights } from './lexical.js';

// Derived indexes only. The canonical body and its revision are never rewritten here.
export const SEARCH_SCHEMA=`
CREATE TABLE IF NOT EXISTS memory_search(
 memory_id TEXT PRIMARY KEY,project_id TEXT,scope TEXT NOT NULL,revision INTEGER NOT NULL,
 status TEXT NOT NULL,profile_id TEXT NOT NULL,branch TEXT,commit_ref TEXT,environment TEXT,expires_at TEXT,
 metadata TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS search_scope ON memory_search(scope,project_id,status,profile_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(chunk_id UNINDEXED,memory_id UNINDEXED,terms,tokenize='unicode61');
INSERT INTO chunk_fts(chunk_fts,rank) VALUES('secure-delete',1);
CREATE TABLE IF NOT EXISTS chunk_identifiers(
 chunk_id INTEGER NOT NULL,memory_id TEXT NOT NULL,identifier TEXT NOT NULL,weight INTEGER NOT NULL,
 PRIMARY KEY(chunk_id,identifier)
);
CREATE INDEX IF NOT EXISTS identifiers_lookup ON chunk_identifiers(identifier,memory_id);
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
CREATE TRIGGER IF NOT EXISTS chunk_search_delete AFTER DELETE ON memory_chunks BEGIN
 DELETE FROM chunk_fts WHERE chunk_id=old.id;
 DELETE FROM chunk_identifiers WHERE chunk_id=old.id;
END;
`;

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
