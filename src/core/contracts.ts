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
export const recordSchema = z.object({
  project_id: z.string().uuid().nullable(), scope: z.enum(['project', 'global']),
  kind: z.enum(['preference', 'fact', 'decision', 'procedure', 'lesson']),
  title: text(180), content: text(4000), tags: z.array(text(80)).max(20).default([]),
  sources: z.array(sourceSchema).min(1).max(12),
  verification: z.object({ method: text(300), summary: text(1000) }).strict(),
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
  context: validSchema.omit({expires_at:true}).default({}), limit: z.number().int().min(1).max(10).default(5)
}).strict().superRefine((r,ctx) => {
  if (Boolean(r.query) === Boolean(r.ids)) ctx.addIssue({code:'custom', message:'exactly one of query or ids required'});
});
export const configSchema = z.object({
  database: z.string().startsWith('/'), model_dir: z.string().startsWith('/'),
  allowed_projects: z.array(z.string().uuid()).min(1), all_projects: z.boolean().default(false), allow_global: z.boolean().default(false),
  operations: z.array(z.enum(['recall','propose','commit','forget','manage'])).min(1),
  semantic_threshold: z.number().min(0).max(1).default(0.425),
  evidence_threshold: z.number().min(0).max(1).default(0.575),
  dtype: z.enum(['fp32','q8']).default('fp32'), threads: z.number().int().min(1).max(8).default(2)
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
