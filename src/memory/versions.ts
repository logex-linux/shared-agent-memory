import type { DatabaseSync } from 'node:sqlite';
import { hash, type MemoryRecord } from '../core/contracts.js';

export function recordHash(record: MemoryRecord): string {
  if (record.memory_form !== undefined || record.episode !== undefined || record.valid_time !== undefined)
    return hash({ envelope: 'sam-record-v1', record });
  return hash(record);
}

export function eventMetadata(record: MemoryRecord) {
  return {
    ...(record.memory_form !== undefined && { memory_form: record.memory_form }),
    ...(record.episode !== undefined && { episode: record.episode }),
    ...(record.valid_time !== undefined && { valid_time: record.valid_time })
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
