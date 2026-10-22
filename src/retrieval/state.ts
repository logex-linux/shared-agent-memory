import { DatabaseSync } from 'node:sqlite';
import { chmodSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hash, MemoryError, type Config } from '../core/contracts.js';
export const RANKING_VERSION = 'adaptive-v1';
export function authority(config: Config, db: DatabaseSync) {
    return hash({ ranking: RANKING_VERSION, database: realpathSync(config.database), connection: config.connection_id, projects: [...config.allowed_projects].sort(), all: config.all_projects, global: config.allow_global, operations: [...config.operations].sort(), semantic: config.semantic_threshold, evidence: config.evidence_threshold, model: config.model_dir, dtype: config.dtype, registry: db.prepare('SELECT id FROM projects ORDER BY id').all() });
}
// Disposable query state: IDs, scores, offsets and facet keys only; never memory bodies.
// A separate WAL writer serializes page creation without locking canonical memory writes.
export class QueryState {
    db: DatabaseSync;
    constructor(main: DatabaseSync, config: Config) {
        const path = realpathSync(config.database) + '.retrieval.db';
        this.db = new DatabaseSync(path);
        chmodSync(path, 0o600);
        this.db.exec(`PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS queries(id TEXT PRIMARY KEY,authority TEXT NOT NULL,generation INTEGER NOT NULL,input TEXT NOT NULL,vector BLOB,profile TEXT,retrieval_mode TEXT NOT NULL,resolved TEXT NOT NULL,progress TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS query_expiry ON queries(expires);
    CREATE TABLE IF NOT EXISTS candidates(q TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,base REAL NOT NULL,admitted INTEGER NOT NULL,emitted INTEGER,project TEXT NOT NULL,topic TEXT NOT NULL,period TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(q,id));
    CREATE INDEX IF NOT EXISTS pending ON candidates(q,emitted,admitted,base);
    CREATE TABLE IF NOT EXISTS seen(q TEXT NOT NULL,channel TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(q,channel,id));
    CREATE TABLE IF NOT EXISTS pages(q TEXT NOT NULL,n INTEGER NOT NULL,ids TEXT NOT NULL,options TEXT NOT NULL,plan TEXT NOT NULL,PRIMARY KEY(q,n));`);
        if (!(main.prepare('PRAGMA database_list').all() as any[]).some(r => r.name === 'retrieval_state'))
            main.prepare('ATTACH DATABASE ? AS retrieval_state').run(path);
    }
    begin() { try {
        this.db.exec('BEGIN IMMEDIATE');
    }
    catch (e: any) {
        if (/busy|locked/i.test(e.message))
            throw new MemoryError('BUSY_RETRYABLE');
        throw e;
    } }
    cleanup() {
        const now = Date.now();
        for (const table of ['candidates', 'seen', 'pages'])
            this.db.prepare(`DELETE FROM ${table} WHERE q IN (SELECT id FROM queries WHERE expires<?)`).run(now);
        this.db.prepare('DELETE FROM queries WHERE expires<?').run(now);
    }
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
    commit() { this.db.exec('COMMIT'); }
    rollback() { if (this.db.isTransaction)
        this.db.exec('ROLLBACK'); }
    close() { this.db.close(); }
}
