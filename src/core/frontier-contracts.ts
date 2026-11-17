import {z} from 'zod';
import {ownershipSchema,planHashSchema,proposeSchema,recallSchema,validSchema,versionRefSchema} from './contracts.js';

const name=z.string().trim().min(1).max(256);
export const taskIdSchema=z.string().uuid();

export const taskOverrideSchema=z.object({
  task_id:taskIdSchema,
  exclude_ids:z.array(z.string().uuid()).max(64).default([]),
  exclude_subjects:z.array(z.object({owner:ownershipSchema,subject_id:name,context_key:name.optional()}).strict()).max(16).default([]),
  ttl_seconds:z.number().int().min(30).max(3600).default(900)
}).strict();

export const admissionSchema=z.object({
  candidate:proposeSchema,
  intent:z.enum(['reusable','progress','receipt','temporary','correct','supersede','variant','derive']).default('reusable'),
  suggestions:z.boolean().default(false)
}).strict();
export const contextPackSchema=z.object({
  read:recallSchema.optional(),
  needed:z.boolean().default(true)
}).strict().refine(input=>!input.needed||Boolean(input.read),'Supply a recall request for tasks that need memory');

export const viewScopeSchema=z.object({
  project_id:z.string().uuid().optional(),include_global:z.boolean().optional(),
  context:validSchema.omit({expires_at:true}).default({}),
  as_of:z.string().datetime().optional(),task_id:taskIdSchema.optional(),
  exclude_ids:z.array(z.string().uuid()).max(64).optional()
}).strict();
export const browseSchema=viewScopeSchema.extend({
  uri:z.string().min(1).max(2048),
  context_key:name.optional(),limit:z.number().int().min(1).max(100).default(25),
  cursor:z.string().max(512).optional()
}).strict();
export const inspectMemorySchema=viewScopeSchema.extend({
  memory_id:z.string().uuid(),revision:z.number().int().positive().safe().optional(),
  token_budget:z.number().int().min(512).max(1000000).optional(),
  max_bytes:z.number().int().min(2048).max(1048576).optional()
}).strict();

const classification=versionRefSchema.extend({
  subject_id:name,context_key:name,aliases:z.array(name).max(12).default([]),
  start:z.number().int().min(0).max(3999),end:z.number().int().min(1).max(4000)
}).strict().superRefine((r,ctx)=>{
  if(r.end<=r.start)ctx.addIssue({code:'custom',path:['end'],message:'Use nonempty UTF-16 offsets into the claim'});
  if(new Set(r.aliases).size!==r.aliases.length || r.aliases.includes(r.subject_id))
    ctx.addIssue({code:'custom',path:['aliases'],message:'Each alias must be distinct from the subject and other aliases'});
});
export const classifySchema=z.object({
  records:z.array(z.union([classification,versionRefSchema.extend({remove:z.literal(true)}).strict()])).min(1).max(50),
  plan_hash:planHashSchema.optional()
}).strict().refine(x=>new Set(x.records.map(r=>r.memory_id)).size===x.records.length,'Use distinct memory IDs');

export type BrowseInput=z.infer<typeof browseSchema>;
export type ViewScope=z.infer<typeof viewScopeSchema>;
export type SubjectSelection=z.infer<typeof taskOverrideSchema>['exclude_subjects'][number];
export type Classification=z.infer<typeof classification>;
