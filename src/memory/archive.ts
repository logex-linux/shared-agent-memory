import { z } from 'zod';
import { MemoryError, recordSchema } from '../core/contracts.js';
import { recordHash } from './versions.js';

export const VERSION_ARCHIVE = 'shared-agent-memory/versions-v1';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const versionSchema = z.object({
  revision:z.number().int().positive().safe(),
  body:z.string(),
  content_hash:digest,
  recorded_at:z.string().datetime(),
  profile_id:z.string().min(1),
  written_by:z.string().min(1)
}).strict();
const entrySchema = z.object({
  id:z.string().uuid(), status:z.enum(['active','invalidated']), created_at:z.string().datetime(),
  versions:z.array(versionSchema).min(1)
}).strict();
const schema = z.object({
  format:z.literal(VERSION_ARCHIVE), generation:z.number().int().nonnegative(),
  export_id:z.string().uuid(), records:z.array(entrySchema), revocations:z.array(z.unknown())
}).strict();

export function parseArchive(raw:unknown) {
  const archive=schema.parse(raw);
  const ids=new Set<string>();
  return archive.records.map(entry=>{
    if (ids.has(entry.id)) throw new MemoryError('ARCHIVE_DUPLICATE_ID');
    ids.add(entry.id);
    const first=entry.versions[0].revision;
    const versions=entry.versions.map((version,index)=>{
      if (version.revision!==first+index) throw new MemoryError('ARCHIVE_REVISION_GAP');
      let body:unknown;
      try { body=JSON.parse(version.body); }
      catch { throw new MemoryError('ARCHIVE_BODY_INVALID'); }
      const record=recordSchema.parse(body);
      if (recordHash(body as typeof record)!==version.content_hash) throw new MemoryError('ARCHIVE_HASH_MISMATCH');
      return {version,record};
    });
    return {...entry,decoded:versions,latest:versions.at(-1)!};
  });
}
