import { z } from 'zod';
import { createHash } from 'node:crypto';

export class MemoryError extends Error {
  constructor(public code: string, message = code) { super(message); }
}
export const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : stable(value)).digest('hex');
export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
const text = (max: number) => z.string().trim().min(1).max(max);
export const sourceSchema = z.object({
  source_type: z.enum(['user', 'code', 'document', 'web', 'test']),
  uri: text(2048), locator: text(500), revision_ref: text(256),
  checked_at: z.string().datetime(), source_hash: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).strict();
export const validSchema = z.object({
  branch: text(256).optional(), commit: text(128).optional(), environment: text(256).optional(),
  expires_at: z.string().datetime().optional()
}).strict();
export const verificationSchema = z.object({
  method:text(300),summary:text(1000),
  status:z.enum(['unverified','verified','disputed']).default('unverified'),
  basis:z.enum(['source_claim','model_inference','user_confirmation','code_review','document_review']).default('source_claim'),
  evidence:text(2000).optional(),reviewer:text(256).optional(),reviewed_at:z.string().datetime().optional()
}).strict();
export const recordSchema = z.object({
  project_id: z.string().uuid().nullable(), scope: z.enum(['project', 'global']),
  kind: z.enum(['preference', 'fact', 'decision', 'procedure', 'lesson']),
  title: text(180), content: text(4000), tags: z.array(text(80)).max(20).default([]),
  sources: z.array(sourceSchema).min(1).max(12),
  verification: verificationSchema,
  valid_for: validSchema.default({}),
  author_client: text(80), author_session: text(256),
  derived_from: z.array(z.object({ memory_id: z.string().uuid(), revision: z.number().int().positive() }).strict()).max(20).default([]),
  import_key: text(256).optional()
}).strict().superRefine((r, ctx) => {
  if ((r.scope === 'global') !== (r.project_id === null)) ctx.addIssue({code:'custom', message:'global requires null project_id; project requires UUID'});
});
export type MemoryRecord = z.infer<typeof recordSchema>;
const request = z.string().uuid();
export const proposeSchema = z.object({ request_id: request, record: recordSchema,
  target_id: z.string().uuid().optional(), expected_revision: z.number().int().positive().optional()
}).strict().superRefine((r,ctx) => {
  if (Boolean(r.target_id) !== Boolean(r.expected_revision)) ctx.addIssue({code:'custom', message:'target_id and expected_revision required together'});
});
export const commitSchema = z.object({ request_id: request, proposal_id: z.string().uuid(), expected_revision: z.number().int().nonnegative() }).strict();
export const forgetSchema = z.object({ request_id: request, memory_id: z.string().uuid(), expected_revision: z.number().int().positive() }).strict();
export const recallSchema = z.object({
  query: text(512).optional(), ids: z.array(z.string().uuid()).min(1).max(10).optional(),
  project_id: z.string().uuid().optional(), include_global: z.boolean().optional(),
  context: validSchema.omit({expires_at:true}).default({}), limit: z.number().int().positive().safe().optional(),
  exact_only:z.boolean().default(false),token_budget:z.number().int().min(512).max(1000000).optional(),
  mode:z.enum(['auto','focused','broad']).optional(),view:z.enum(['chunks','evidence']).optional(),
  cursor:text(160).optional(),debug:z.boolean().default(false),max_bytes:z.number().int().min(2048).max(1048576).optional()
}).strict().superRefine((r,ctx) => {
  if (Number(Boolean(r.query))+Number(Boolean(r.ids))+Number(Boolean(r.cursor))!==1) ctx.addIssue({code:'custom', message:'exactly one of query, ids or cursor required'});
  if(r.exact_only && !r.query)ctx.addIssue({code:'custom',message:'exact_only requires query'});
});
export const configSchema = z.object({
  database: z.string().startsWith('/'), model_dir: z.string().startsWith('/'),
  allowed_projects: z.array(z.string().uuid()).min(1), all_projects: z.boolean().default(false), allow_global: z.boolean().default(false),
  operations: z.array(z.enum(['recall','propose','commit','forget','manage','verify'])).min(1).default(['recall']),
  connection_id:text(256).default('local-core'),
  semantic_threshold: z.number().min(0).max(1).default(0.425),
  evidence_threshold: z.number().min(0).max(1).default(0.575),
  dtype: z.enum(['fp32','q8']).default('fp32'), threads: z.number().int().min(1).max(8).default(2),
  response_token_budget:z.number().int().min(512).max(1000000).default(6000),
  page_response_bytes:z.number().int().min(2048).max(1048576).default(32000),
  page_item_limit:z.number().int().min(1).max(10000).default(128),
  page_candidate_budget:z.number().int().min(32).max(10000).default(512),
  page_time_budget_ms:z.number().int().min(10).max(60000).default(2000),
  query_ttl_seconds:z.number().int().min(1).max(86400).default(1800),
  cache_max_bytes:z.number().int().min(65536).max(1073741824).default(67108864),
  cache_query_max_bytes:z.number().int().min(16384).max(1073741824).default(8388608),
  cache_disk_max_bytes:z.number().int().min(1048576).max(4294967296).default(134217728),
  cache_cleanup_rows:z.number().int().min(1).max(4096).default(256),
  diagnostics:z.boolean().default(false)
}).strict();
export type Config = z.infer<typeof configSchema>;
export type RecallInput = z.infer<typeof recallSchema>;
export type ProposeInput = z.infer<typeof proposeSchema>;
export interface Chunk { text: string; start: number; end: number; tokens: number; vector: Float32Array }
export interface Encoder {
  profile(): Promise<{id:string; manifest:unknown}>;
  query(text:string): Promise<Float32Array>;
  chunks(title:string,content:string): Promise<Chunk[]>;
}
export function applicability(valid: z.infer<typeof validSchema>, context: RecallInput['context']): 'current'|'requires_check'|'excluded' {
  if (valid.expires_at && Date.parse(valid.expires_at) <= Date.now()) return 'excluded';
  let missing = false;
  for (const key of ['branch','commit','environment'] as const) {
    if (valid[key] && context[key] && valid[key] !== context[key]) return 'excluded';
    if (valid[key] && !context[key]) missing = true;
  }
  return missing ? 'requires_check' : 'current';
}
