import type { DatabaseSync } from 'node:sqlite';

export function migrateErasure(db:DatabaseSync) {
  db.exec(`
    CREATE TABLE version_dependencies(
      parent_id TEXT NOT NULL,child_id TEXT NOT NULL,child_revision INTEGER NOT NULL,
      PRIMARY KEY(parent_id,child_id,child_revision),
      FOREIGN KEY(child_id,child_revision) REFERENCES memory_versions(memory_id,revision) ON DELETE CASCADE
    );
    CREATE INDEX version_dependencies_child ON version_dependencies(child_id,child_revision);
    CREATE INDEX version_content_hash ON memory_versions(content_hash);
    INSERT OR IGNORE INTO version_dependencies
      SELECT json_extract(d.value,'$.memory_id'),v.memory_id,v.revision
      FROM memory_versions v,json_each(v.body,'$.derived_from') d;
    CREATE TRIGGER version_dependency_insert AFTER INSERT ON memory_versions BEGIN
      INSERT OR IGNORE INTO version_dependencies
        SELECT json_extract(d.value,'$.memory_id'),new.memory_id,new.revision
        FROM json_each(new.body,'$.derived_from') d;
    END;
    CREATE TABLE revoked_aliases(
      memory_id TEXT NOT NULL REFERENCES tombstones(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('import_key','source_hash')),value TEXT NOT NULL,
      PRIMARY KEY(memory_id,kind,value)
    );
    CREATE INDEX revoked_alias_lookup ON revoked_aliases(kind,value);
  `);
}

export function revokeVersions(db:DatabaseSync,id:string) {
  db.prepare('INSERT OR IGNORE INTO revoked_version_hashes SELECT memory_id,content_hash FROM memory_versions WHERE memory_id=?').run(id);
  db.prepare(`INSERT OR IGNORE INTO revoked_aliases SELECT memory_id,'import_key',json_extract(body,'$.import_key')
    FROM memory_versions WHERE memory_id=? AND json_extract(body,'$.import_key') IS NOT NULL`).run(id);
  db.prepare(`INSERT OR IGNORE INTO revoked_aliases SELECT v.memory_id,'source_hash',json_extract(s.value,'$.source_hash')
    FROM memory_versions v,json_each(v.body,'$.sources') s WHERE v.memory_id=?
    AND json_extract(s.value,'$.source_hash') IS NOT NULL`).run(id);
}
