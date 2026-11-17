import type {DatabaseSync} from 'node:sqlite';
import {hash,MemoryError,type Config} from '../core/contracts.js';
import type {SubjectSelection} from '../core/frontier-contracts.js';
import {authority,QueryState} from './state.js';
import {HISTORICAL_SUBJECT,HISTORICAL_CONTEXT} from '../memory/subjects.js';

const MAX_EXCLUSIONS=4096;
type Overrides={ids:string[];subjects:SubjectSelection[]};
const SELECTORS=`SELECT json_extract(value,'$.owner.scope') scope,json_extract(value,'$.owner.project_id') project_id,
  json_extract(value,'$.subject_id') subject_id,json_extract(value,'$.context_key') context_key FROM json_each(?)`;

function normalized(input:Overrides) {
  return {ids:[...new Set(input.ids)].sort(),
    subjects:[...new Map(input.subjects.map(subject=>[hash(subject),subject])).entries()]
      .sort(([a],[b])=>a.localeCompare(b)).map(([,subject])=>subject)};
}

function resolveAliases(db:DatabaseSync,subjects:SubjectSelection[]) {
  if(!subjects.length)return [];
  const rows=db.prepare(`WITH selectors AS (${SELECTORS}) SELECT DISTINCT s.scope,s.project_id,i.subject_id,i.context_key
    FROM claim_projection i JOIN memory_search s ON s.memory_id=i.memory_id AND s.revision=i.revision
    JOIN selectors q ON s.scope=q.scope AND s.project_id IS q.project_id AND (q.context_key IS NULL OR i.context_key=q.context_key)
    WHERE s.status='active' AND s.lifecycle='current' AND EXISTS(SELECT 1 FROM json_each(i.aliases) a WHERE a.value=q.subject_id)
      AND NOT EXISTS(SELECT 1 FROM memory_search e WHERE e.scope=s.scope AND e.project_id IS s.project_id
        AND e.context_key=i.context_key AND e.subject_id=q.subject_id AND e.lifecycle='current' AND e.status='active')
    LIMIT 129`).all(JSON.stringify(subjects));
  if(rows.length>128)throw new MemoryError('TASK_OVERRIDE_TOO_BROAD');
  return rows.map(row=>({owner:{scope:row.scope,project_id:row.project_id},subject_id:row.subject_id,context_key:row.context_key}) as SubjectSelection);
}

function exclusions(db:DatabaseSync,{ids,subjects}:Overrides) {
  if(!ids.length&&!subjects.length)return [];
  // Include the original IDs even after reassignment or a later identity change.
  // Walk provenance as well as current identity so exact old versions cannot
  // disclose a suppressed source through a derived record.
  const rows=db.prepare(`WITH RECURSIVE selectors AS MATERIALIZED (${SELECTORS}), named AS MATERIALIZED (
    SELECT s.memory_id FROM selectors q CROSS JOIN memory_search s
      WHERE s.subject_id=q.subject_id AND (q.context_key IS NULL OR s.context_key=q.context_key)
      AND s.scope=q.scope AND s.project_id IS q.project_id AND s.status='active'
    UNION
    SELECT i.memory_id FROM selectors q CROSS JOIN claim_projection i
      JOIN memory_search s ON s.memory_id=i.memory_id AND s.revision=i.revision
      WHERE i.subject_id=q.subject_id AND (q.context_key IS NULL OR i.context_key=q.context_key)
      AND s.scope=q.scope AND s.project_id IS q.project_id AND s.status='active'
    UNION
    SELECT v.memory_id FROM selectors q CROSS JOIN memory_versions v
      JOIN memory_search s ON s.memory_id=v.memory_id
      WHERE v.body_state<>'head' AND ${HISTORICAL_SUBJECT}=q.subject_id AND (q.context_key IS NULL OR ${HISTORICAL_CONTEXT}=q.context_key)
      AND s.scope=q.scope AND s.project_id IS q.project_id AND s.status='active'
  ), parent_edges AS MATERIALIZED (
    SELECT parent_id parent,child_id child FROM dependencies
    UNION
    SELECT parent_id,child_id FROM version_dependencies
  ), suppressed(id) AS (
    SELECT value FROM json_each(?) UNION SELECT memory_id FROM named
    UNION SELECT e.child FROM parent_edges e JOIN suppressed s ON e.parent=s.id
  ) SELECT id FROM suppressed LIMIT ?`).all(JSON.stringify(subjects),JSON.stringify(ids),MAX_EXCLUSIONS+1);
  if(rows.length>MAX_EXCLUSIONS)throw new MemoryError('TASK_OVERRIDE_TOO_BROAD');
  return rows.map(r=>String(r.id)).sort();
}

export function startTaskOverride(db:DatabaseSync,config:Config,generation:number,task_id:string,input:Overrides,ttl:number) {
  const state=QueryState.open(db,config),auth=authority(config,db),rules=normalized(input),fingerprint=hash(rules);
  const lease=state.lease('task',task_id,auth);
  if(lease&&JSON.parse(lease.payload).fingerprint!==fingerprint)throw new MemoryError('TASK_OVERRIDE_EXISTS');
  if(lease)return {task_id,expires_at:new Date(lease.expires).toISOString()};
  const resolved=normalized({...rules,subjects:[...rules.subjects,...resolveAliases(db,rules.subjects)]});
  const expires=state.saveLease('task',task_id,auth,generation,
    JSON.stringify({rules:resolved,fingerprint,anchors:exclusions(db,resolved)}),Date.now()+ttl*1000);
  return {task_id,expires_at:new Date(expires).toISOString()};
}

export function taskExclusions(db:DatabaseSync,config:Config,generation:number,task_id?:string) {
  if(!task_id)return;
  const state=QueryState.open(db,config);
  const lease=state.lease('task',task_id,authority(config,db));
  if(!lease)throw new MemoryError('TASK_OVERRIDE_UNAVAILABLE');
  const {rules,anchors}=JSON.parse(lease.payload) as {rules:Overrides;anchors:string[]};
  return {ids:lease.generation===generation?anchors:exclusions(db,{ids:anchors,
    subjects:[...rules.subjects,...resolveAliases(db,rules.subjects)]}),
    binding:hash([lease.expires,lease.payload])};
}
