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
  db.prepare('INSERT OR IGNORE INTO revoked_aliases SELECT memory_id,kind,value FROM version_aliases WHERE memory_id=?').run(id);
}

export function erasureTree(db:DatabaseSync,id:string) {
  return db.prepare(`WITH RECURSIVE children(id) AS (
    VALUES(?) UNION SELECT d.child_id FROM dependencies d JOIN children c ON d.parent_id=c.id
    UNION SELECT d.child_id FROM version_dependencies d JOIN children c ON d.parent_id=c.id
    UNION SELECT copy.memory_id FROM children c JOIN memory_versions v ON v.memory_id=c.id
      JOIN memory_versions copy ON copy.content_hash=v.content_hash
  ) SELECT id FROM children ORDER BY id`).all(id).map(row=>String(row.id));
}
