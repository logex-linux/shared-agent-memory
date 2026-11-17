import type {DatabaseSync} from 'node:sqlite';
import {MemoryError, type Ownership} from '../core/contracts.js';

export const sameOwnership=(a:Ownership,b:Ownership)=>a.scope===b.scope && a.project_id===b.project_id;

export function relatedProposals(db:DatabaseSync,ids:string[]) {
  const scope=JSON.stringify(ids);
  return db.prepare(`WITH moving(id) AS (SELECT value FROM json_each(?))
    SELECT p.id,p.project_id,p.scope,p.expected_revision,p.target_id,p.connection_id
    FROM proposals p LEFT JOIN proposal_transitions t ON p.id=t.proposal_id
     LEFT JOIN import_targets i ON p.id=i.proposal_id
    WHERE p.status='pending' AND (p.target_id IN moving OR i.memory_id IN moving
      OR EXISTS (SELECT 1 FROM json_each(p.body,'$.derived_from') d WHERE json_extract(d.value,'$.memory_id') IN moving)
      OR EXISTS (SELECT 1 FROM json_each(t.plan,'$.expected_refs') r WHERE json_extract(r.value,'$.memory_id') IN moving))
    ORDER BY p.id`).all(scope) as (Ownership&{id:string;expected_revision:number;target_id:string|null;connection_id:string})[];
}

export function managedExports(db:DatabaseSync,ids:string[]) {
  return db.prepare(`SELECT id,ids,status FROM exports e WHERE e.status<>'removed'
    AND EXISTS (SELECT 1 FROM json_each(e.ids) WHERE value IN (SELECT value FROM json_each(?)))
    ORDER BY id`).all(JSON.stringify(ids)) as {id:string;ids:string;status:string}[];
}

export function ownershipImpact(db:DatabaseSync,ids:string[],destination:Ownership,authorize:(scope:Ownership)=>void) {
  const selected=new Set(ids), list=JSON.stringify(ids);
  const references=db.prepare(`WITH moving(id) AS (SELECT value FROM json_each(?))
    SELECT parent_id a,child_id b,'dependency' kind,parent_revision revision FROM dependencies
      WHERE parent_id IN moving OR child_id IN moving
    UNION SELECT parent_id,child_id,'historical_dependency',child_revision FROM version_dependencies
      WHERE parent_id IN moving OR child_id IN moving
    UNION SELECT from_id,to_id,'relation',revision FROM memory_relations WHERE from_id IN moving OR to_id IN moving
    UNION SELECT a,b,'feedback',seq FROM learning_events WHERE a IN moving OR b IN moving
    UNION SELECT a,b,'association',last_seq FROM association_edges WHERE a IN moving OR b IN moving
    ORDER BY kind,a,b,revision`).all(list) as {a:string;b:string;kind:string;revision:number}[];
  const scopeOf=db.prepare('SELECT project_id,scope FROM memories WHERE id=?');
  const scopeCache=new Map<string,Ownership>();
  const current=(id:string)=>{
    let scope=scopeCache.get(id);
    if(!scope) {
      scope=scopeOf.get(id) as Ownership|undefined;
      if(!scope)throw new MemoryError('REASSIGN_REFERENCE_MISSING');
      authorize(scope);
      scopeCache.set(id,scope);
    }
    return scope;
  };
  const blocked=references.filter(({a,b,kind})=>{
    const oldA=current(a),oldB=current(b);
    const nextA=selected.has(a)?destination:oldA,nextB=selected.has(b)?destination:oldB;
    return kind.endsWith('dependency')?nextA.scope==='project'&&!sameOwnership(nextA,nextB):!sameOwnership(nextA,nextB);
  });
  const proposals=relatedProposals(db,ids);
  for(const proposal of proposals)authorize(proposal);
  const exports=managedExports(db,ids);
  for(const entry of exports)for(const id of JSON.parse(entry.ids) as string[]) {
    const scope=scopeOf.get(id) as Ownership|undefined;
    if(scope)authorize(scope);
  }
  return {references,blocked,proposals,exports:exports.map(({id,status})=>({id,status}))};
}
