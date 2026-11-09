import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { MemoryError, sourceSchema, versionRefSchema, type RecallInput } from '../core/contracts.js';

export const GRAPH_VERSION = 'explicit-relations-v1';
export const GRAPH_SEEDS = 8;
export const GRAPH_NEIGHBORS = 16;
export const GRAPH_PAGE_WORK = 128;
const DEPENDENCY_LIMIT = 128;
const MAX_DEPTH = 2;
type Ref = z.infer<typeof versionRefSchema>;
type Direction = 'outgoing'|'incoming';
type EdgeType = 'supports'|'related_to'|'context_variant';
type Step = {id:string; revision:number; type:EdgeType; from:Ref; to:Ref; direction:Direction};
export type GraphPath = {seed:Ref; steps:Step[]};
type Frontier = {node:Ref; path:GraphPath; direction:Direction; after:string; examined:number};
export type GraphProgress = {
    epoch:number; version:string; profile:string|null;
    seeded:boolean; frontier:Frontier[]; seen:string[];
    neighborLimited:boolean; dependencyLimited:boolean; stale:boolean;
};
type Node = Ref & {scope:string; project:string|null};
type EdgeRow = {
    id:string; revision:number; from_id:string; from_revision:number; to_id:string; to_revision:number;
    scope:string; project_id:string|null; type:string; valid_sources:number;
};
const validSources = z.array(sourceSchema).min(1).max(12);

export function migrateGraph(db:DatabaseSync) {
    db.exec(`
      INSERT INTO meta(key,value) VALUES('graph_epoch',0);
      CREATE INDEX relation_from_walk ON memory_relations(from_id,id);
      CREATE INDEX relation_to_walk ON memory_relations(to_id,id);
      CREATE INDEX tombstones_hash ON tombstones(content_hash);
    `);
}

export function graphEpoch(db:DatabaseSync) {
    const row=db.prepare(`SELECT value FROM meta WHERE key='graph_epoch'
      AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_relations')`).get();
    if(!row || typeof row.value!=='number' || !Number.isSafeInteger(row.value) || row.value<0)
        throw new MemoryError('GRAPH_UNAVAILABLE');
    return row.value;
}

export function startGraph(epoch:number,profile:string|null):GraphProgress {
    return {epoch,version:GRAPH_VERSION,profile,seeded:false,frontier:[],seen:[],neighborLimited:false,dependencyLimited:false,stale:false};
}

export function graphBonus(path:GraphPath) {
    // Association affects opportunity. It does not supply claim evidence.
    return path.steps.reduce((weight,step)=>weight * (step.type==='supports'
        ? step.direction==='incoming'?1:.65
        : step.type==='context_variant'?.45:.7),.023/path.steps.length);
}

export class GraphReader {
    private nodes = new Map<string,Node|null>();
    private checks = new Map<string,'valid'|'stale'|'limited'>();
    private readonly visible;
    constructor(private db:DatabaseSync, eligible:{sql:string;params:SQLInputValue[]}, input:RecallInput) {
        const knownTime=input.as_of? ` AND json_extract(s.metadata,'$.valid_time.valid_from') IS NOT NULL
            AND json_extract(s.metadata,'$.valid_time.valid_to') IS NOT NULL`:'';
        const statement=db.prepare(`SELECT s.memory_id,s.revision,s.scope,s.project_id FROM memory_search s
            JOIN memories m ON m.id=s.memory_id
            WHERE s.memory_id=? AND ${eligible.sql} AND m.revision=s.revision
            AND coalesce(json_extract(s.metadata,'$.lifecycle'),'current')<>'quarantined'
            AND (s.branch IS NULL OR s.branch=?) AND (s.commit_ref IS NULL OR s.commit_ref=?)
            AND (s.environment IS NULL OR s.environment=?) ${knownTime}
            AND NOT EXISTS(SELECT 1 FROM tombstones t WHERE t.id=m.id OR t.content_hash=m.content_hash)
            AND NOT EXISTS(SELECT 1 FROM revoked_version_hashes r WHERE r.content_hash=m.content_hash)`);
        this.visible=(id:string)=>statement.get(id,...eligible.params,input.context.branch??null,input.context.commit??null,input.context.environment??null);
    }
    private node(id:string) {
        if(!this.nodes.has(id)) {
            const row=this.visible(id);
            this.nodes.set(id,row?{memory_id:id,revision:Number(row.revision),scope:String(row.scope),project:row.project_id as string|null}:null);
        }
        return this.nodes.get(id);
    }
    private valid(ref:Ref,state?:GraphProgress) {
        const node=this.node(ref.memory_id);
        if(!node || node.revision!==ref.revision)return null;
        if(!this.checks.has(ref.memory_id)) {
            const ancestors=this.db.prepare(`WITH RECURSIVE ancestors(id,revision) AS (
              SELECT parent_id,parent_revision FROM dependencies WHERE child_id=?
              UNION
              SELECT d.parent_id,d.parent_revision FROM dependencies d JOIN ancestors a ON a.id=d.child_id
              LIMIT ?
            ) SELECT id,revision FROM ancestors`).all(ref.memory_id,DEPENDENCY_LIMIT+1);
            const check=ancestors.length>DEPENDENCY_LIMIT?'limited':ancestors.some(r=>
                r.id===ref.memory_id || this.node(String(r.id))?.revision!==r.revision)?'stale':'valid';
            this.checks.set(ref.memory_id,check);
        }
        const check=this.checks.get(ref.memory_id);
        if(state && check==='limited')state.dependencyLimited=true;
        return check==='valid'?node:null;
    }
    seed(state:GraphProgress,ids:string[],baseDone:boolean) {
        if(state.seeded)return;
        const roots=ids.flatMap(id=>{
            const node=this.node(id);
            const ref=node && {memory_id:id,revision:node.revision};
            return ref&&this.valid(ref,state)?[ref]:[];
        }).slice(0,GRAPH_SEEDS);
        state.seeded=roots.length>0||baseDone;
        state.seen=roots.map(r=>r.memory_id);
        state.frontier=roots.map(node=>this.frontier(node,{seed:node,steps:[]}));
    }
    private frontier(node:Ref,path:GraphPath):Frontier {
        return {node,path,direction:'outgoing',after:'',examined:0};
    }
    private next(node:string,direction:Direction,after:string) {
        const column=direction==='outgoing'?'from_id':'to_id';
        return this.db.prepare(`SELECT id,revision,type,from_id,from_revision,to_id,to_revision,scope,project_id,
          json_valid(sources) valid_sources FROM memory_relations WHERE ${column}=? AND id>? ORDER BY id LIMIT 1`)
            .get(node,after) as EdgeRow|undefined;
    }
    private step(row:EdgeRow,direction:Direction,state?:GraphProgress):Step|null {
        if(row.type!=='supports' && row.type!=='related_to' && row.type!=='context_variant')return null;
        const from={memory_id:row.from_id,revision:row.from_revision},to={memory_id:row.to_id,revision:row.to_revision};
        const visibleFrom=this.node(row.from_id),visibleTo=this.node(row.to_id);
        if(state&&visibleFrom&&visibleTo&&visibleFrom.project===row.project_id&&visibleTo.project===row.project_id&&
           (visibleFrom.revision!==row.from_revision||visibleTo.revision!==row.to_revision))state.stale=true;
        const left=this.valid(from,state),right=this.valid(to,state);
        if(!left || !right || left.scope!==row.scope || right.scope!==row.scope ||
            left.project!==row.project_id || right.project!==row.project_id)return null;
        if(!row.valid_sources)throw new MemoryError('GRAPH_UNAVAILABLE');
        return {id:row.id,revision:row.revision,type:row.type,from,to,direction};
    }
    walk(state:GraphProgress,budget:number,deadline:number,visit:(path:GraphPath)=>void) {
        const seen=new Set(state.seen);
        let examined=0;
        while(state.frontier.length && examined<budget && performance.now()<deadline) {
            const entry=state.frontier[0];
            if(!this.valid(entry.node,state)) {
                state.frontier.shift();
                continue;
            }
            const row=this.next(entry.node.memory_id,entry.direction,entry.after);
            if(entry.examined===GRAPH_NEIGHBORS) {
                const extra=row || entry.direction==='outgoing' && this.next(entry.node.memory_id,'incoming','');
                if(extra)state.neighborLimited=true;
                state.frontier.shift();
                continue;
            }
            if(!row) {
                if(entry.direction==='incoming')state.frontier.shift();
                else {entry.direction='incoming';entry.after='';}
                continue;
            }
            entry.after=row.id;
            entry.examined++;
            examined++;
            const step=this.step(row,entry.direction,state);
            if(!step)continue;
            const node=step.direction==='outgoing'?step.to:step.from;
            if(seen.has(node.memory_id))continue;
            seen.add(node.memory_id);
            const path={seed:entry.path.seed,steps:[...entry.path.steps,step]};
            visit(path);
            if(path.steps.length<MAX_DEPTH)state.frontier.push(this.frontier(node,path));
        }
        state.seen=[...seen];
        return examined;
    }
    explain(path:GraphPath) {
        const statement=this.db.prepare(`SELECT *,json_valid(sources) valid_sources
            FROM memory_relations WHERE id=?`);
        const steps=path.steps.map(step=>{
            const row=statement.get(step.id) as (EdgeRow & {sources:string})|undefined;
            const current=row&&this.step(row,step.direction);
            if(!current || JSON.stringify(current)!==JSON.stringify(step))throw new MemoryError('GRAPH_STALE');
            const sources=validSources.safeParse(JSON.parse(row!.sources));
            if(!sources.success)throw new MemoryError('GRAPH_UNAVAILABLE');
            return {...current,sources:sources.data};
        });
        return {seed:path.seed,steps};
    }
}

export function destination(path:GraphPath):Ref {
    const step=path.steps[path.steps.length-1];
    return step.direction==='outgoing'?step.to:step.from;
}

export function readGraph<T>(operation:()=>T):T {
    try { return operation(); }
    catch(error) {
        if(error instanceof MemoryError)throw error;
        if(error instanceof Error && (error as NodeJS.ErrnoException).code==='ERR_SQLITE_ERROR')
            throw new MemoryError('GRAPH_UNAVAILABLE');
        throw error;
    }
}
