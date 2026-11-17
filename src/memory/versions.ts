import type { DatabaseSync } from 'node:sqlite';
import { hash, type MemoryRecord } from '../core/contracts.js';

export function recordHash(record: MemoryRecord): string {
  if (Object.keys(extendedMetadata(record)).length)
    return hash({ envelope: 'sam-record-v1', record });
  return hash(record);
}

export function extendedMetadata(record: MemoryRecord) {
  return {
    ...(record.memory_form !== undefined && { memory_form: record.memory_form }),
    ...(record.episode !== undefined && { episode: record.episode }),
    ...(record.valid_time !== undefined && { valid_time: record.valid_time }),
    ...(record.decision_state !== undefined && { decision_state: record.decision_state }),
    ...(record.lifecycle !== undefined && { lifecycle: record.lifecycle }),
    ...(record.subject_id !== undefined && { subject_id: record.subject_id }),
    ...(record.context_key !== undefined && { context_key: record.context_key }),
    ...(record.consolidation !== undefined && { consolidation: record.consolidation })
  };
}

export function migrateVersions(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE memory_versions(
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK(revision > 0),
      body TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      written_by TEXT NOT NULL,
      PRIMARY KEY(memory_id,revision)
    );
    INSERT INTO memory_versions
      SELECT id,revision,body,content_hash,verified_at,profile_id,written_by FROM memories;
    CREATE TRIGGER version_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memory_versions VALUES(new.id,new.revision,new.body,new.content_hash,new.verified_at,new.profile_id,new.written_by);
    END;
    CREATE TRIGGER version_advance AFTER UPDATE OF revision ON memories WHEN new.revision <> old.revision BEGIN
      INSERT INTO memory_versions VALUES(new.id,new.revision,new.body,new.content_hash,new.verified_at,new.profile_id,new.written_by);
    END;
    CREATE TABLE revoked_version_hashes(
      memory_id TEXT NOT NULL REFERENCES tombstones(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      PRIMARY KEY(memory_id,content_hash)
    );
    CREATE INDEX revoked_versions_by_hash ON revoked_version_hashes(content_hash);
  `);
}

export function compactVersionBodies(db: DatabaseSync) {
  // A head row keeps its original revision metadata and foreign-key identity.
  // Its empty body resolves to the current record until that record advances.
  db.exec(`
    DROP TRIGGER version_insert;
    DROP TRIGGER version_advance;
    DROP TRIGGER version_dependency_insert;
    UPDATE memory_versions AS v SET body='' WHERE EXISTS (
      SELECT 1 FROM memories m WHERE m.id=v.memory_id AND m.revision=v.revision AND m.body=v.body
    );
    CREATE VIEW memory_version_bodies AS
      SELECT v.memory_id,v.revision,coalesce(nullif(v.body,''),m.body) AS body,
        v.content_hash,v.recorded_at,v.profile_id,v.written_by
      FROM memory_versions v LEFT JOIN memories m ON m.id=v.memory_id AND m.revision=v.revision;
    CREATE TRIGGER version_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memory_versions VALUES(new.id,new.revision,'',new.content_hash,new.verified_at,new.profile_id,new.written_by);
    END;
    CREATE TRIGGER version_advance AFTER UPDATE OF revision ON memories WHEN new.revision <> old.revision BEGIN
      UPDATE memory_versions SET body=old.body WHERE memory_id=old.id AND revision=old.revision AND body='';
      INSERT INTO memory_versions VALUES(new.id,new.revision,'',new.content_hash,new.verified_at,new.profile_id,new.written_by);
    END;
    CREATE TRIGGER version_dependency_insert AFTER INSERT ON memory_versions BEGIN
      INSERT OR IGNORE INTO version_dependencies
        SELECT json_extract(d.value,'$.memory_id'),v.memory_id,v.revision
        FROM memory_version_bodies v,json_each(v.body,'$.derived_from') d
        WHERE v.memory_id=new.memory_id AND v.revision=new.revision;
    END;
  `);
}

export function migrateVersionLifecycle(db:DatabaseSync) {
  db.exec(`
    ALTER TABLE memory_versions ADD COLUMN body_state TEXT NOT NULL DEFAULT 'stored' CHECK(body_state IN ('head','stored','pruned'));
    ALTER TABLE memory_versions ADD COLUMN pruned_context TEXT;
    ALTER TABLE version_dependencies ADD COLUMN parent_revision INTEGER;
    UPDATE memory_versions SET body_state='head' WHERE body='';
    DROP TRIGGER version_insert;
    DROP TRIGGER version_advance;
    DROP TRIGGER version_dependency_insert;
    DROP VIEW memory_version_bodies;
    CREATE VIEW memory_version_bodies AS
      SELECT v.memory_id,v.revision,CASE v.body_state WHEN 'head' THEN m.body WHEN 'stored' THEN v.body END AS body,
        v.content_hash,v.recorded_at,v.profile_id,v.written_by,v.body_state,v.pruned_context
      FROM memory_versions v LEFT JOIN memories m ON m.id=v.memory_id AND m.revision=v.revision;
    CREATE TRIGGER version_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memory_versions(memory_id,revision,body,content_hash,recorded_at,profile_id,written_by,body_state)
        VALUES(new.id,new.revision,'',new.content_hash,new.verified_at,new.profile_id,new.written_by,'head');
    END;
    CREATE TRIGGER version_advance AFTER UPDATE OF revision ON memories WHEN new.revision<>old.revision BEGIN
      UPDATE memory_versions SET body=old.body,body_state='stored'
        WHERE memory_id=old.id AND revision=old.revision AND body_state='head';
      INSERT INTO memory_versions(memory_id,revision,body,content_hash,recorded_at,profile_id,written_by,body_state)
        VALUES(new.id,new.revision,'',new.content_hash,new.verified_at,new.profile_id,new.written_by,'head');
    END;
    UPDATE version_dependencies SET parent_revision=(SELECT min(json_extract(d.value,'$.revision'))
      FROM memory_version_bodies v,json_each(v.body,'$.derived_from') d WHERE v.memory_id=child_id
        AND v.revision=child_revision AND json_extract(d.value,'$.memory_id')=parent_id);
    CREATE TABLE version_aliases(
      memory_id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('import_key','source_hash')),value TEXT NOT NULL,
      PRIMARY KEY(memory_id,revision,kind,value),
      FOREIGN KEY(memory_id,revision) REFERENCES memory_versions(memory_id,revision) ON DELETE CASCADE
    );
    CREATE VIEW version_body_aliases AS
      SELECT memory_id,revision,'import_key' kind,json_extract(body,'$.import_key') value
        FROM memory_version_bodies WHERE json_extract(body,'$.import_key') IS NOT NULL
      UNION ALL SELECT v.memory_id,v.revision,'source_hash',json_extract(s.value,'$.source_hash')
        FROM memory_version_bodies v,json_each(v.body,'$.sources') s WHERE json_extract(s.value,'$.source_hash') IS NOT NULL;
    INSERT OR IGNORE INTO version_aliases SELECT * FROM version_body_aliases;
    CREATE TRIGGER version_dependency_insert AFTER INSERT ON memory_versions BEGIN
      INSERT OR IGNORE INTO version_dependencies(parent_id,child_id,child_revision,parent_revision)
        SELECT json_extract(d.value,'$.memory_id'),v.memory_id,v.revision,json_extract(d.value,'$.revision')
        FROM memory_version_bodies v,json_each(v.body,'$.derived_from') d
        WHERE v.memory_id=new.memory_id AND v.revision=new.revision;
      INSERT OR IGNORE INTO version_aliases SELECT * FROM version_body_aliases WHERE memory_id=new.memory_id AND revision=new.revision;
    END;
  `);
}
