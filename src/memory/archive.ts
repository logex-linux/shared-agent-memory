import { z } from 'zod';
import { MemoryError, recordSchema, validSchema, decisionStateSchema, versionRefSchema } from '../core/contracts.js';
import { recordHash } from './versions.js';

export const LEGACY_VERSION_ARCHIVE = 'shared-agent-memory/versions-v1';
export const VERSION_ARCHIVE = 'shared-agent-memory/versions-v2';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const versionSchema = z.object({
  revision:z.number().int().positive().safe(),
  body:z.string(),
  content_hash:digest,
  recorded_at:z.string().datetime(),
  profile_id:z.string().min(1),
  written_by:z.string().min(1)
}).strict();
const context=z.object({
  valid_for:validSchema.strict().nullable(),
  valid_time:z.object({valid_from:z.string().datetime().optional(),valid_to:z.string().datetime().optional()}).strict().nullable(),
  decision_state:decisionStateSchema.nullable(),subject_id:z.string().max(256).nullable(),context_key:z.string().max(256).nullable()
}).strict();
const alias=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('source_hash'),value:digest}).strict(),
  z.object({kind:z.literal('import_key'),value:z.string().min(1).max(256)}).strict()
]);
const pruned=versionSchema.omit({body:true}).extend({
  body_state:z.literal('pruned'),pruned_context:context,aliases:z.array(alias).max(13),dependencies:z.array(versionRefSchema).max(20)
}).strict();
const stored=versionSchema.extend({body_state:z.literal('stored')});
const head=versionSchema.extend({body_state:z.literal('head')});
const entrySchema = z.object({
  id:z.string().uuid(), status:z.enum(['active','invalidated']), created_at:z.string().datetime()
}).strict();
const common=z.object({generation:z.number().int().nonnegative(),export_id:z.string().uuid(),revocations:z.array(z.unknown())}).strict();
const schema=z.discriminatedUnion('format',[
  common.extend({format:z.literal(LEGACY_VERSION_ARCHIVE),records:z.array(entrySchema.extend({versions:z.array(versionSchema).min(1)}))}),
  common.extend({format:z.literal(VERSION_ARCHIVE),records:z.array(entrySchema.extend({versions:z.array(z.discriminatedUnion('body_state',[head,stored,pruned])).min(1)}))})
]);
type ArchiveVersion=z.infer<typeof head>|z.infer<typeof stored>|z.infer<typeof pruned>;

export function parseArchive(raw:unknown) {
  const archive=schema.parse(raw);
  const ids=new Set<string>();
  return archive.records.map(entry=>{
    if (ids.has(entry.id)) throw new MemoryError('ARCHIVE_DUPLICATE_ID');
    ids.add(entry.id);
    const first=entry.versions[0].revision;
    const versions:ArchiveVersion[]=entry.versions.map((version,index)=>{
      if('body_state' in version)return version;
      return {...version,body_state:index===entry.versions.length-1?'head':'stored'};
    });
    const decoded=versions.flatMap((version,index)=>{
      if (version.revision!==first+index) throw new MemoryError('ARCHIVE_REVISION_GAP');
      if ((version.body_state==='head')!==(index===versions.length-1))throw new MemoryError('ARCHIVE_HEAD_INVALID');
      if(version.body_state==='pruned')return [];
      let body:unknown;
      try { body=JSON.parse(version.body); }
      catch { throw new MemoryError('ARCHIVE_BODY_INVALID'); }
      const record=recordSchema.parse(body);
      if (recordHash(body as typeof record)!==version.content_hash) throw new MemoryError('ARCHIVE_HASH_MISMATCH');
      return [{version,record}];
    });
    return {...entry,format:archive.format,versions,decoded,latest:decoded.at(-1)!};
  });
}
