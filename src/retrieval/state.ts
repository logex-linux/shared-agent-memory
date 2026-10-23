import { prepared } from '../storage/statements.js';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, realpathSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hash, MemoryError, type Config } from '../core/contracts.js';
export const RANKING_VERSION = 'adaptive-v041';
export function authority(config: Config, db: DatabaseSync) {
    return hash({ ranking: RANKING_VERSION, database: realpathSync(config.database), connection: config.connection_id, projects: [...config.allowed_projects].sort(), all: config.all_projects, global: config.allow_global, operations: [...config.operations].sort(), semantic: config.semantic_threshold, evidence: config.evidence_threshold, model: config.model_dir, dtype: config.dtype, registry: db.prepare('SELECT id FROM projects ORDER BY id').all() });
}
// Disposable query state: IDs, scores, offsets and facet keys only; never memory bodies.
// A separate WAL writer serializes page creation without locking canonical memory writes.
export class QueryState {
    private static instances=new WeakMap<DatabaseSync,QueryState>();private pooled=false;
    static open(main:DatabaseSync,config:Config){let state=this.instances.get(main);if(!state){state=new QueryState(main,config);state.pooled=true;this.instances.set(main,state);}state.constructorConfig=config;state.timing={wait_ms:0,held_ms:0,transactions:0};return state;}
    static dispose(main:DatabaseSync){const state=this.instances.get(main);if(state){state.db.close();this.instances.delete(main);}}
    cleanupIfExpired(){if(!this.db.prepare('SELECT 1 FROM queries WHERE expires<? LIMIT 1').get(Date.now()))return false;this.begin();try{this.cleanup();this.commit();return true;}catch(e){this.rollback();throw e;}}

    db: DatabaseSync;
    timing={wait_ms:0,held_ms:0,transactions:0};private heldAt=0;
    path: string;
    constructorConfig: Config;
    constructor(main: DatabaseSync, config: Config) {
        this.constructorConfig=config;
        const path = this.path = realpathSync(config.database) + '.retrieval.db';
        this.db = prepared(new DatabaseSync(path));
        chmodSync(path, 0o600);
        const initialize=()=>this.db.exec(`PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;PRAGMA secure_delete=ON;PRAGMA wal_autocheckpoint=256;PRAGMA journal_size_limit=1048576;
    CREATE TABLE IF NOT EXISTS queries(id TEXT PRIMARY KEY,authority TEXT NOT NULL,generation INTEGER NOT NULL,input TEXT NOT NULL,vector BLOB,profile TEXT,retrieval_mode TEXT NOT NULL,resolved TEXT NOT NULL,progress TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS query_expiry ON queries(expires);
    CREATE TABLE IF NOT EXISTS candidates(q TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,base REAL NOT NULL,admitted INTEGER NOT NULL,emitted INTEGER,project TEXT NOT NULL,topic TEXT NOT NULL,period TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(q,id));
    CREATE INDEX IF NOT EXISTS pending ON candidates(q,emitted,admitted,base);
    CREATE TABLE IF NOT EXISTS seen(q TEXT NOT NULL,channel TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(q,channel,id));
    CREATE TABLE IF NOT EXISTS pages(q TEXT NOT NULL,n INTEGER NOT NULL,ids TEXT NOT NULL,options TEXT NOT NULL,plan TEXT NOT NULL,PRIMARY KEY(q,n));`);
        const deadline=Date.now()+5000;for(;;){try{initialize();break;}catch(e:any){if(!/busy|locked/i.test(e.message)||Date.now()>=deadline)throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}
        // Additive, disposable sidecar migration. Canonical Schema 5 is untouched.
        const initialized=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cache_meta'").get();
        if(!initialized) {
            this.begin();
            try {
              if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cache_meta'").get()) {
                this.db.exec(`CREATE TABLE IF NOT EXISTS cache_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS cache_usage(q TEXT PRIMARY KEY,bytes INTEGER NOT NULL);`);
                const sizes:Record<string,string>={queries:"length(CAST(input AS BLOB))+coalesce(length(vector),0)+length(CAST(progress AS BLOB))+512",candidates:"length(CAST(data AS BLOB))+256",seen:"128",pages:"length(CAST(ids AS BLOB))+length(CAST(options AS BLOB))+length(CAST(plan AS BLOB))+128"};
                for(const [table,size] of Object.entries(sizes)) {
                    const key=table==='queries'?'id':'q';
                    this.db.exec(`INSERT INTO cache_usage SELECT ${key},sum(${size}) FROM ${table} GROUP BY ${key} ON CONFLICT(q) DO UPDATE SET bytes=bytes+excluded.bytes;`);
                    const expr=(prefix:string)=>size.replace(/\b(input|vector|progress|data|ids|options|plan)\b/g,prefix+'.$1');
                    this.db.exec(`CREATE TRIGGER IF NOT EXISTS usage_${table}_insert AFTER INSERT ON ${table} BEGIN INSERT INTO cache_usage VALUES(new.${key},${expr('new')}) ON CONFLICT(q) DO UPDATE SET bytes=bytes+excluded.bytes; END;
                    CREATE TRIGGER IF NOT EXISTS usage_${table}_delete AFTER DELETE ON ${table} BEGIN UPDATE cache_usage SET bytes=bytes-(${expr('old')}) WHERE q=old.${key}; END;
                    CREATE TRIGGER IF NOT EXISTS usage_${table}_update AFTER UPDATE ON ${table} BEGIN UPDATE cache_usage SET bytes=bytes+(${expr('new')})-(${expr('old')}) WHERE q=new.${key}; END;`);
                }
                this.db.exec("INSERT OR IGNORE INTO cache_meta VALUES('rejections',0);");
              }
                this.commit();
            }catch(e){this.rollback();throw e;}
        }
        const pageSize=Number((this.db.prepare('PRAGMA page_size').get() as any).page_size);
        // Caps allocated DB pages, including freelist. WAL is separately checkpointed/reused.
        this.db.exec('PRAGMA max_page_count='+Math.max(1,Math.floor(config.cache_disk_max_bytes/pageSize)));
        if (!(main.prepare('PRAGMA database_list').all() as any[]).some(r => r.name === 'retrieval_state'))
            main.prepare('ATTACH DATABASE ? AS retrieval_state').run(path);
    }
    begin() { try {
        const start=performance.now();this.db.exec('BEGIN IMMEDIATE');this.timing.wait_ms+=performance.now()-start;this.heldAt=performance.now();this.timing.transactions++;
    }
    catch (e: any) {
        if (/busy|locked/i.test(e.message))
            throw new MemoryError('BUSY_RETRYABLE');
        throw e;
    } }
    cleanup() {
        const started=performance.now(),now=Date.now();let remaining=this.constructorConfig.cache_cleanup_rows,deleted=0;
        // One small transaction, no VACUUM. Partial expiry keeps the query unresumable.
        for (const table of ['candidates', 'seen', 'pages']) {
            if(!remaining)break;
            const r=this.db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE q IN (SELECT id FROM queries WHERE expires<?) LIMIT ?)`).run(now,remaining);
            remaining-=Number(r.changes);deleted+=Number(r.changes);
        }
        if(remaining) {
            const r=this.db.prepare(`DELETE FROM queries WHERE id IN (SELECT id FROM queries WHERE expires<? AND NOT EXISTS(SELECT 1 FROM candidates WHERE q=queries.id) AND NOT EXISTS(SELECT 1 FROM seen WHERE q=queries.id) AND NOT EXISTS(SELECT 1 FROM pages WHERE q=queries.id) LIMIT ?)`).run(now,remaining);
            deleted+=Number(r.changes);
        }
        this.db.exec('DELETE FROM cache_usage WHERE bytes=0');
        const update=this.db.prepare('INSERT OR REPLACE INTO cache_meta VALUES(?,?)');
        update.run('cleanup_at',now);update.run('cleanup_rows',deleted);update.run('cleanup_us',Math.round((performance.now()-started)*1000));
        return {deleted_rows:deleted,elapsed_ms:performance.now()-started};
    }
    enforce(q:string) {
        const r=this.db.prepare('SELECT coalesce(sum(bytes),0) total,coalesce(max(CASE WHEN q=? THEN bytes END),0) own FROM cache_usage').get(q) as any;
        if(r.total>this.constructorConfig.cache_max_bytes || r.own>this.constructorConfig.cache_query_max_bytes)
            throw new MemoryError('QUERY_CACHE_CAPACITY');
        // A new page may add at most one bounded page transaction beyond this observation.
        if(this.diskBytes()>this.constructorConfig.cache_disk_max_bytes+2097152)
            throw new MemoryError('QUERY_CACHE_DISK_CAPACITY');
    }
    rejected() {
        // Called after rolling back a failed page; telemetry survives that rollback.
        this.db.prepare("UPDATE cache_meta SET value=value+1 WHERE key='rejections'").run();
    }
    diskBytes() {return ['', '-wal', '-shm'].reduce((n,suffix)=>{try{return n+statSync(this.path+suffix).size;}catch{return n;}},0);}
    inspect() {
        const now=Date.now(),counts=this.db.prepare('SELECT sum(expires>=?) active,sum(expires<?) expired FROM queries').get(now,now) as any;
        return {active_queries:counts.active??0,expired_queries:counts.expired??0,disk_bytes:this.diskBytes(),logical_bytes:(this.db.prepare('SELECT coalesce(sum(bytes),0) n FROM cache_usage').get() as any).n,candidates:(this.db.prepare('SELECT count(*) n FROM candidates').get() as any).n,limits:{logical:this.constructorConfig.cache_max_bytes,query:this.constructorConfig.cache_query_max_bytes,allocated_database:this.constructorConfig.cache_disk_max_bytes},stats:Object.fromEntries((this.db.prepare('SELECT key,value FROM cache_meta').all() as any[]).map(r=>[r.key,r.value]))};
    }
    checkpoint() {return this.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();}
    create(values: {
        authority: string;
        generation: number;
        input: string;
        vector: Buffer | null;
        profile: string | null;
        retrieval_mode: string;
        resolved: string;
        progress: string;
        expires: number;
    }) {
        const id = randomUUID();
        this.db.prepare('INSERT INTO queries VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, values.authority, values.generation, values.input, values.vector, values.profile, values.retrieval_mode, values.resolved, values.progress, values.expires);
        return id;
    }
    lookup(cursor: string) {
        const match = /^am4:([0-9a-f-]{36}):(\d+)$/.exec(cursor);
        if (!match || !Number.isSafeInteger(Number(match[2])))
            throw new MemoryError('CURSOR_INVALID');
        const row = this.db.prepare('SELECT * FROM queries WHERE id=?').get(match[1]) as any;
        if (!row || row.expires < Date.now())
            throw new MemoryError('CURSOR_EXPIRED');
        return { row, page: Number(match[2]) };
    }
    cursor(q: string, page: number) { return `am4:${q}:${page}`; }
    commit() { this.db.exec('COMMIT');this.timing.held_ms+=performance.now()-this.heldAt; }
    rollback() { if (this.db.isTransaction)
        this.db.exec('ROLLBACK'); }
    close() { if(!this.pooled)this.db.close(); }
}
