import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { MemoryError, verificationSchema, hash, type Config, type Encoder, type RecallInput } from '../core/contracts.js';
import { identifiers, ftsQuery, terms } from './lexical.js';
import { answerIntent, factState, focusTerms, evidenceWindow, referenceEvidence, type FactState } from './evidence.js';
import { prepared } from '../storage/statements.js';
import { RetrievalProfile } from './profile.js';
import { QueryState, authority } from './state.js';
type Context = {
    db: DatabaseSync;
    config: Config;
    encoder: Encoder;
    generation: () => number;
};
type Candidate = {
    specificTopic?: boolean;
    id: string;
    head: number;
    rrf: number;
    exact: number;
    cosine?: number;
    coverage: number;
    reasons: string[];
    hits: [
        number,
        number
    ][];
    project: string;
    topic: string;
    period: string;
    source: string;
    family: string;
    matchedTags: string[];
    tagMatch: boolean;
    kind: string;
    requiresCheck: boolean;
    base: number;
    admitted: boolean;
    answer?: { state: FactState; coverage: number; alignment: number; checked: string; salient?: boolean; subjectMatches?: number; referenceBackground?: boolean };
};
const blob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
// These describe the request, rather than its subject; they must not dominate IDF anchors.
const salienceScaffolding=new Set(terms('用户 已 废弃 改用 决定 配置 入口 最近 排错 记录 相关 当前 已有 既有'));
export const estimateTokens = (bytes: number) => Math.ceil(bytes / 3);
function eligibility(input: RecallInput, config: Config) {
    const params: SQLInputValue[] = [Number(!input.project_id && config.all_projects), JSON.stringify(input.project_id ? [input.project_id] : config.allowed_projects), Number(input.include_global ?? (!input.project_id && config.allow_global)), new Date().toISOString()];
    let sql = "s.status='active' AND ((s.scope='project' AND s.project_id IN (SELECT p.id FROM projects p WHERE ?=1 OR p.id IN (SELECT value FROM json_each(?)))) OR (?=1 AND s.scope='global')) AND (s.expires_at IS NULL OR julianday(s.expires_at)>julianday(?))";
    for (const [column, key] of [['branch', 'branch'], ['commit_ref', 'commit'], ['environment', 'environment']] as const) {
        sql += ` AND (s.${column} IS NULL OR ? IS NULL OR s.${column}=?)`;
        params.push(input.context[key] ?? null, input.context[key] ?? null);
    }
    return { sql, params };
}
const broadIntent = (q: string) => /(长期|稳定.*偏好|偏好|习惯|倾向|审美|归纳|总结|跨项目|多年来|反复.*选择|preferences?|patterns?|career|across.*projects)/i.test(q);
function assess(c: Candidate, config: Config, broad: boolean, progress: any) {
    const semantic = (c.cosine ?? 0) >= config.semantic_threshold, strong = (c.cosine ?? 0) >= config.evidence_threshold;
    const core = c.exact > 0 || c.coverage >= .6 || semantic && (c.coverage >= .2 || strong);
    const hints: string[] = progress.hints ?? [];
    c.tagMatch = c.matchedTags.some(t => hints.includes(t));
    const tail = hints.length ? c.exact > 0 || c.tagMatch && (semantic || c.coverage >= .2) || core && (c.cosine ?? 0) >= Math.max(config.evidence_threshold, (progress.peak ?? 1) - .04) : core || broad && semantic && c.family === progress.family;
    c.admitted = progress.anchors?.includes(c.id) || tail;
    c.base = c.rrf + Math.min(c.exact, 3) * .01;
    if (!broad && c.answer) {
        const a=c.answer, peak=progress.peak??0, topicBridge=(progress.identifierTopics??[]).includes(c.topic);
        const local = a.coverage>0, near = (c.cosine??0)>=Math.max(config.evidence_threshold,peak-.04);
        // A semantic-only candidate remains possible. It must have a strong distribution signal;
        // exact IDs are complementary, never a mandatory constraint outside exact_only.
        c.admitted = tail || topicBridge&&semantic || near || a.coverage>=.5 || !progress.hasIdentifiers&&progress.anchors?.includes(c.id);
        if (progress.hasIdentifiers && c.exact===0 && !topicBridge)
            c.admitted = local&&strong&&a.coverage>=.5 || (c.cosine??0)>=Math.max(config.evidence_threshold,peak+.04);
        // Provenance labels shared by a large part of the library are not topical evidence.
        // Keep semantic paraphrases; lexical/background matches need local, distinctive support.
        if (!c.specificTopic && c.exact===0)
            c.admitted = (c.cosine??0)>=Math.min(1,config.evidence_threshold+.1) || near&&a.coverage>=.2 || a.coverage>=.5&&Boolean(a.salient) || semantic&&Boolean(a.salient)&&(a.coverage>=.2||(a.subjectMatches??0)>=2);
        c.base = c.rrf + Number(c.exact>0)*.06 + a.coverage*.045 + a.alignment*.035;
    }
}
export async function retrieve(ctx: Context, request: RecallInput, channel: 'hybrid' | 'lexical' | 'vector') {
    const { config, encoder } = ctx, profileTrace=(request.debug||config.diagnostics)?new RetrievalProfile():undefined, db=profileTrace?.database(prepared(ctx.db))??prepared(ctx.db), start = performance.now(), debug = request.debug || config.diagnostics;
    const d = { elapsed_ms: 0, candidate_ids: 0, candidates_ranked: 0, full_body_records_read: 0, full_body_bytes_read: 0, json_parses: 0, metadata_json_parses: 0, chunk_text_rows_read: 0, vector_queries: 0, vector_rows_returned: 0, vector_internal_scanned: null, vector_distance_computations: null, query_embeddings: 0, response_bytes: 0, estimated_tokens: 0, content_estimated_tokens: 0, token_estimator: 'ceil(utf8_bytes/3)', cache_replay: false, ranking_chunk_rows_read: 0 };
    let traceResponse:any,traceBudget=config.page_response_bytes;
    const parse = (s: string, metadata = false) => { d.json_parses++; if (metadata)
        d.metadata_json_parses++; return JSON.parse(s); };
    let input = request, queryVector: Buffer | null = null, profile: string | null = null, retrievalMode: string = request.ids ? 'ids' : channel, warnings: string[] = [], state: QueryState | undefined, q = '', page = 0, resolved = 'focused', progress: any = { vectorDone: channel === 'lexical', ftsDone: channel === 'vector', idDone: false, vectorRank: 0, ftsRank: 0, batch: 32, warnings: [] }, savedPage: any;
    const embeddingStarted=performance.now();
    if (!request.cursor && request.query && channel !== 'lexical')
        try {
            profile = (await encoder.profile()).id;
            d.query_embeddings++;
            queryVector = blob(await encoder.query(request.query));
        }
        catch (e) {
            if (e instanceof MemoryError && e.code === 'QUERY_TOO_LONG')
                throw e;
            retrievalMode = 'lexical_degraded';
            warnings.push('EMBEDDING_UNAVAILABLE');
        }
    profileTrace?.add('embedding',performance.now()-embeddingStarted);
    try {
        if (!request.ids) {
            const opened=performance.now();
            state = QueryState.open(ctx.db, config);
            profileTrace?.add('state_open',performance.now()-opened);
            const cleaning=performance.now();state.cleanupIfExpired();profileTrace?.add('cleanup',performance.now()-cleaning);
            const lockStarted=performance.now();state.begin();profileTrace?.add('state_wait',performance.now()-lockStarted);
            if (request.cursor) {
                const found = state.lookup(request.cursor);
                q = found.row.id;
                page = found.page;
                input = parse(found.row.input);
                queryVector = found.row.vector ? Buffer.from(found.row.vector) : null;
                profile = found.row.profile;
                retrievalMode = found.row.retrieval_mode;
                resolved = found.row.resolved;
                progress = parse(found.row.progress);
                warnings = progress.warnings;
                for (const key of ['project_id', 'include_global', 'mode'] as const)
                    if (request[key] !== undefined && request[key] !== input[key])
                        throw new MemoryError('CURSOR_QUERY_MISMATCH');
                if (Object.keys(request.context).length && hash(request.context) !== hash(input.context))
                    throw new MemoryError('CURSOR_QUERY_MISMATCH');
            }
        }
        // Freeze expiry after query encoding; all channels and materialization share this snapshot.
        const candidateStarted=performance.now();db.exec('BEGIN');
        const gen = ctx.generation(), auth = authority(config, db), eligible = eligibility(input, config);
        if (state) {
            if (request.cursor) {
                const row = state.db.prepare('SELECT authority,generation FROM queries WHERE id=?').get(q) as any;
                if (row.authority !== auth)
                    throw new MemoryError('CURSOR_SCOPE_CHANGED');
                if (row.generation !== gen)
                    throw new MemoryError('CURSOR_STALE');
                savedPage = state.db.prepare('SELECT * FROM pages WHERE q=? AND n=?').get(q, page);
                if (!savedPage && page !== Number((state.db.prepare('SELECT coalesce(max(n),-1)+1 n FROM pages WHERE q=?').get(q) as any).n))
                    throw new MemoryError('CURSOR_INVALID');
            }
            else {
                resolved = input.mode === 'broad' || (!input.mode || input.mode === 'auto') && broadIntent(input.query!) ? 'broad' : 'focused';
                progress.vectorDone = !queryVector;
                progress.ftsDone = channel === 'vector' && retrievalMode !== 'lexical_degraded';
                progress.idDone = !identifiers(input.query!).length || (channel === 'vector' && !input.exact_only && retrievalMode !== 'lexical_degraded');
                progress.warnings = warnings;
                q = state.create({ authority: auth, generation: gen, input: JSON.stringify(input), vector: queryVector, profile, retrieval_mode: retrievalMode, resolved, progress: JSON.stringify(progress), expires: Date.now() + config.query_ttl_seconds * 1000 });
            }
        }
        if (queryVector && retrievalMode !== 'lexical_degraded' && !savedPage) {
            const profiles = (db.prepare(`SELECT DISTINCT s.profile_id FROM memory_search s WHERE ${eligible.sql}`).all(...eligible.params) as any[]).map(r => r.profile_id);
            const incomplete = db.prepare(`SELECT 1 FROM memory_search s WHERE ${eligible.sql} AND (NOT EXISTS(SELECT 1 FROM memory_chunks c WHERE c.memory_id=s.memory_id) OR EXISTS(SELECT 1 FROM memory_chunks c WHERE c.memory_id=s.memory_id AND (c.revision!=s.revision OR c.profile_id!=s.profile_id OR c.id NOT IN (SELECT chunk_id FROM memory_vec)))) LIMIT 1`).get(...eligible.params);
            if (profiles.some(p => p !== profile) || incomplete) {
                if (request.cursor)
                    throw new MemoryError('CURSOR_INDEX_CHANGED');
                warnings.push(incomplete ? 'INDEX_INCOMPLETE' : 'INDEX_PROFILE_MISMATCH');
                retrievalMode = 'lexical_degraded';
                progress.vectorDone = true;
                progress.ftsDone = false;
                progress.idDone = !identifiers(input.query!).length;
            }
        }
        const local = { vector: new Set<string>(), fts: new Set<string>(), identifier: new Set<string>() }, candidates = new Map<string, Candidate>();
        let work = 0, lowGain = false;
        const seen = (ch: keyof typeof local, id: string) => { local[ch].add(id); state!.db.prepare('INSERT OR IGNORE INTO seen VALUES(?,?,?)').run(q, ch, id); };
        const exclusion = (ch: keyof typeof local) => `s.memory_id NOT IN (SELECT id FROM retrieval_state.seen WHERE q=? AND channel='${ch}') AND s.memory_id NOT IN (SELECT value FROM json_each(?))`;
        const analysisMetadata=new Map<string,any>(),topicCounts=new Map<string,number>();
        const candidate = (id: string) => {
            if (!candidates.has(id)) {
                const old = state!.db.prepare('SELECT data FROM candidates WHERE q=? AND id=?').get(q, id) as any;
                if (old)
                    candidates.set(id, parse(old.data));
                else {
                    const r = db.prepare("SELECT s.project_id,s.branch,s.commit_ref,s.environment,json_extract(s.metadata,'$.kind') kind,json_extract(s.metadata,'$.title') title,json_extract(s.metadata,'$.verification.basis') basis,json_extract(s.metadata,'$.verification.status') status,json_extract(s.metadata,'$.tags') tags,json_extract(s.metadata,'$.sources[0].checked_at') date,json_extract(s.metadata,'$.sources[0].uri') source FROM memory_search s WHERE s.memory_id=?").get(id) as any;
                    analysisMetadata.set(id,r);
                    const tags: string[] = parse(r.tags ?? '[]');
                    const topic=tags.at(-1);
                    candidates.set(id, { id, head: 0, rrf: 0, exact: 0, coverage: 0, reasons: [], hits: [], project: r.project_id ?? 'global', topic: hash(tags.at(-1) ?? r.kind), period: (r.date ?? 'unknown').slice(0, 7), source: hash((r.source ?? '').replace(/\/[^/]*$/, '')), family: tags.length ? hash(tags[0]) : '', matchedTags: tags.filter(t => t.length >= 2 && input.query!.toLowerCase().includes(t.toLowerCase())), tagMatch: false, kind: r.kind, requiresCheck: Boolean(r.branch && !input.context.branch || r.commit_ref && !input.context.commit || r.environment && !input.context.environment), base: 0, admitted: false });
                    const sourceParts=String(r.source??'').toLowerCase().split(/[/.]/);
                    const sourceLabel=topic&&sourceParts.includes(topic.toLowerCase());
                    if(resolved==='focused'&&sourceLabel&&!topicCounts.has(topic))topicCounts.set(topic,Number((db.prepare(`SELECT count(*) n FROM (SELECT 1 FROM memory_search s WHERE ${eligible.sql} AND EXISTS(SELECT 1 FROM json_each(json_extract(s.metadata,'$.tags')) WHERE value=?) LIMIT 3)`).get(...eligible.params,topic) as any).n));
                    candidates.get(id)!.specificTopic=!(sourceLabel&&(topicCounts.get(topic)??0)>=3);
                }
            }
            return candidates.get(id)!;
        };
        const hit = (c: Candidate, id: number, p: number) => { const hits = new Map(c.hits); hits.set(id, Math.max(hits.get(id) ?? -Infinity, p)); c.hits = [...hits].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 2); };
        const reason = (c: Candidate, r: string) => { if (!c.reasons.includes(r))
            c.reasons.push(r); };
        const chunkCache=new Map<number,any>();
        const readChunks=(id:string,ids:number[])=>{
            const missing=ids.filter(id=>!chunkCache.has(id));let read=0;
            if(missing.length){
                const rows=db.prepare('SELECT id,start,end,text FROM memory_chunks WHERE memory_id=? AND revision=(SELECT revision FROM memory_search WHERE memory_id=?) AND id IN (SELECT value FROM json_each(?)) ORDER BY start').all(id,id,JSON.stringify(missing)) as any[];
                read=rows.length;for(const row of rows)chunkCache.set(row.id,row);
            }
            return {rows:ids.map(id=>chunkCache.get(id)).filter(Boolean).sort((a,b)=>a.start-b.start),read};
        };
        const queryTerms=input.query?focusTerms(input.query):[], termWeights=new Map<string,number>(),references=resolved==='focused'?referenceEvidence(input.query??''):undefined;
        const queryIdentifiers=identifiers(input.query??'').filter(id=>input.exact_only||!/^20\d{2}$/.test(id)||queryTerms.length===1);
        if(resolved==='focused'&&input.query) {
            db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.recall_vocab USING fts5vocab(main,chunk_fts,'row')");
            const total=Number((db.prepare('SELECT count(*) n FROM memory_chunks').get() as any).n);
            for(const r of db.prepare('SELECT term,doc FROM temp.recall_vocab WHERE term IN (SELECT value FROM json_each(?))').all(JSON.stringify(queryTerms)) as any[])
                termWeights.set(r.term,Math.log(1+total/(1+r.doc)));
        }
        const analyze = (c: Candidate) => {
            if (resolved!=='focused') return;
            const signature=JSON.stringify(c.hits.map(h=>h[0]));
            if (c.answer?.checked===signature) return;
            const rankingStarted=performance.now();
            const previousStage=profileTrace?.current;if(profileTrace)profileTrace.current='ranking';
            const meta=analysisMetadata.get(c.id)??db.prepare("SELECT json_extract(metadata,'$.title') title,json_extract(metadata,'$.verification.basis') basis,json_extract(metadata,'$.verification.status') status FROM memory_search WHERE memory_id=?").get(c.id) as any;
            const loaded=readChunks(c.id,c.hits.map(h=>h[0])),chunks=loaded.rows;
            d.ranking_chunk_rows_read+=loaded.read;
            const text=[meta.title,...chunks.map(r=>r.text)].join('\n'), words=new Set(terms(text)), qt=queryTerms;
            const denominator=qt.reduce((n,t)=>n+(termWeights.get(t)??Math.log(2+Number((progress.vectorRank??0)+32))),0);
            const coverage=denominator?qt.filter(t=>words.has(t)).reduce((n,t)=>n+(termWeights.get(t)??1),0)/denominator:0;
            const state=factState(chunks.map(r=>r.text).join('\n'),meta.basis,meta.status==='disputed'), intent=answerIntent(input.query!);
            const alignment=intent==='unknown'?0:state===intent?1:state==='unknown'?0:state==='disputed'?-.35:-1;
            const salient=queryTerms.filter(t=>t.length>=2&&!salienceScaffolding.has(t)&&termWeights.has(t)).sort((a,b)=>termWeights.get(b)!-termWeights.get(a)!);
            const salientWeight=salient.length?termWeights.get(salient[0])!:Infinity;
            const salientMatches=salient.filter(t=>termWeights.get(t)!>=salientWeight*.85&&words.has(t)).length;
            const refs=references!(text,words);
            // Preserve semantic paraphrases and accessible cross-project context. A partial
            // generic filename alone cannot support the rest of a specific reference query.
            const referenceBackground=refs.count>0&&refs.coverage<.5&&!(refs.subjectCoverage>=.6&&salientMatches>0);
            c.answer={state,coverage,alignment,checked:signature,salient:salientMatches>0,subjectMatches:salient.filter(t=>words.has(t)).length,referenceBackground};
            if(profileTrace){profileTrace.current=previousStage!;profileTrace.add('ranking',performance.now()-rankingStarted);}
        };
        const persist = () => { for (const c of candidates.values()) {
            analyze(c);
            assess(c, config, resolved === 'broad', progress);
            state!.db.prepare(`INSERT INTO candidates(q,id,data,base,admitted,project,topic,period,source) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(q,id) DO UPDATE SET data=excluded.data,base=excluded.base,admitted=excluded.admitted`).run(q, c.id, JSON.stringify(c), c.base, Number(c.admitted), c.project, c.topic, c.period, c.source);
        } };
        if (state && !savedPage) {
            do {
                const k = Math.min(progress.batch, config.page_candidate_budget - work);
                if (k < 1)
                    break;
                if (!progress.vectorDone)
                    try {
                        const rows = db.prepare(`SELECT chunk_id,distance FROM memory_vec WHERE embedding MATCH ? AND k=? AND distance<=? AND chunk_id IN (SELECT c.id FROM memory_chunks c JOIN memory_search s ON s.memory_id=c.memory_id WHERE ${eligible.sql} AND c.revision=s.revision AND c.profile_id=s.profile_id AND ${exclusion('vector')}) ORDER BY distance`).all(queryVector!, Math.min(k, 4096), 1 - config.semantic_threshold, ...eligible.params, q, JSON.stringify([...local.vector])) as any[];
                        d.vector_queries++;
                        d.vector_rows_returned += rows.length;
                        work += rows.length;
                        const owners = new Map((db.prepare('SELECT id,memory_id FROM memory_chunks WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(rows.map(r => r.chunk_id))) as any[]).map(r => [r.id, r.memory_id]));
                        const batch = new Set<string>();
                        for (const r of rows) {
                            const id = owners.get(r.chunk_id)!;
                            if (!batch.has(id)) {
                                batch.add(id);
                                const c = candidate(id);
                                c.cosine = Math.max(c.cosine ?? -1, 1 - r.distance);
                                const rank = ++progress.vectorRank;
                                c.rrf += 1 / (60 + rank);
                                if (rank <= 20)
                                    c.head += 1 / (60 + rank);
                                reason(c, 'semantic');
                            }
                            hit(candidate(id), r.chunk_id, 1 - r.distance);
                        }
                        for (const id of batch)
                            seen('vector', id);
                        if (rows.length < k)
                            progress.vectorDone = true;
                    }
                    catch (e) {
                        retrievalMode = 'lexical_degraded';
                        warnings.push(e instanceof MemoryError ? e.code : 'VECTOR_INDEX_UNAVAILABLE');
                        progress.vectorDone = true;
                        progress.ftsDone = false;
                        progress.idDone = !identifiers(input.query!).length;
                    }
                if (!progress.ftsDone && work < config.page_candidate_budget) {
                    const fq = ftsQuery(input.query!);
                    if (!fq)
                        progress.ftsDone = true;
                    else {
                        const n = Math.min(k, config.page_candidate_budget - work), rows = db.prepare(`SELECT chunk_id,memory_id,terms,bm25(chunk_fts) rank FROM chunk_fts WHERE chunk_fts MATCH ? AND chunk_id IN (SELECT c.id FROM memory_chunks c JOIN memory_search s ON s.memory_id=c.memory_id WHERE ${eligible.sql} AND c.revision=s.revision AND c.profile_id=s.profile_id AND ${exclusion('fts')}) ORDER BY rank,chunk_id LIMIT ?`).all(fq, ...eligible.params, q, JSON.stringify([...local.fts]), n) as any[];
                        work += rows.length;
                        const qt = terms(input.query!), batch = new Set<string>();
                        for (const r of rows) {
                            const c = candidate(r.memory_id), words = new Set(r.terms.split(' ')), coverage = qt.length ? qt.filter(t => words.has(t)).length / qt.length : 0;
                            c.coverage = Math.max(c.coverage, coverage);
                            if (!batch.has(r.memory_id)) {
                                batch.add(r.memory_id);
                                const rank = ++progress.ftsRank;
                                c.rrf += .125 * Math.max(.1, coverage) / (60 + rank);
                                if (rank <= 20)
                                    c.head += .125 / (60 + rank);
                                reason(c, coverage >= .6 ? 'lexical' : 'lexical_weak');
                            }
                            hit(c, Number(r.chunk_id), .02 + coverage * .1);
                        }
                        for (const id of batch)
                            seen('fts', id);
                        if (rows.length < n)
                            progress.ftsDone = true;
                    }
                }
                if (!progress.idDone && work < config.page_candidate_budget) {
                    const n = Math.min(k, config.page_candidate_budget - work), rows = db.prepare(`WITH matches AS MATERIALIZED (SELECT i.* FROM chunk_identifiers i JOIN memory_chunks c ON c.id=i.chunk_id JOIN memory_search s ON s.memory_id=i.memory_id WHERE i.identifier IN (SELECT value FROM json_each(?)) AND ${eligible.sql} AND c.revision=s.revision AND c.profile_id=s.profile_id AND ${exclusion('identifier')}), per_identifier AS (SELECT memory_id,identifier,max(weight) weight FROM matches GROUP BY memory_id,identifier),totals AS (SELECT memory_id,sum(weight) exact FROM per_identifier GROUP BY memory_id) SELECT t.*,(SELECT chunk_id FROM matches h WHERE h.memory_id=t.memory_id ORDER BY weight DESC,chunk_id LIMIT 1) chunk_id FROM totals t ORDER BY exact DESC,memory_id LIMIT ?`).all(JSON.stringify(resolved==='broad'?identifiers(input.query!):queryIdentifiers), ...eligible.params, q, JSON.stringify([...local.identifier]), n) as any[];
                    work += rows.length;
                    for (const r of rows) {
                        const c = candidate(r.memory_id);
                        c.exact = r.exact;
                        reason(c, 'identifier');
                        hit(c, r.chunk_id, 2 + r.exact);
                        seen('identifier', r.memory_id);
                    }
                    if (rows.length < n)
                        progress.idDone = true;
                }
                if (!progress.anchors) {
                    const initial = [...candidates.values()].sort((a, b) => Number(a.requiresCheck) - Number(b.requiresCheck) || (b.head + Math.min(b.exact, 3) * .01) - (a.head + Math.min(a.exact, 3) * .01) || a.id.localeCompare(b.id));
                    progress.anchors = initial.filter(c => c.head > 0 || c.exact > 0).slice(0, 5).map(c => c.id);
                    const counts = new Map<string, number>();
                    for (const c of initial)
                        for (const t of c.matchedTags)
                            counts.set(t, (counts.get(t) ?? 0) + 1);
                    const smallest = Math.min(...counts.values());
                    progress.hints = [...counts].filter(([, n]) => n <= smallest * 3).map(([t]) => t);
                    progress.hasIdentifiers=initial.some(c=>c.exact>0);
                    for(const c of initial)analyze(c);
                    progress.identifierTopics=[...new Set(initial.filter(c=>c.exact>0&&(!c.answer||['unknown','implemented'].includes(c.answer.state))).map(c=>c.topic))];
                    progress.peak = Math.max(0, ...initial.map(c => c.cosine ?? 0));
                    // Coherent topical families recover indirect decisions as well as explicit preferences.
                    // Inference uses only strong early evidence across multiple contexts, never a user profile.
                    const strong = initial.filter(c => (c.cosine ?? 0) >= config.evidence_threshold).slice(0, 8), families = new Map<string, Candidate[]>();
                    for (const c of strong)
                        if (c.family)
                            families.set(c.family, [...(families.get(c.family) ?? []), c]);
                    progress.family = [...families].find(([, cs]) => cs.length >= 3 && cs.length / Math.max(1, strong.length) >= .6 && new Set(cs.map(c => c.project + c.period)).size >= 3)?.[0] ?? null;
                }
                persist();
                // Auto uses intent plus a multi-facet candidate distribution, never query length.
                if (!input.mode || input.mode === 'auto') {
                    const sample = [...candidates.values()].filter(c => c.admitted);
                    if (!identifiers(input.query!).length && sample.length >= 4 && sample.filter(c => c.kind === 'preference').length / sample.length >= .6 && new Set(sample.map(c => c.project + c.period + c.topic)).size >= 3)
                        resolved = 'broad';
                }
                progress.batch = Math.min(256, progress.batch * 2);
                const count = state.db.prepare(`SELECT count(*) n,count(DISTINCT project||topic||period) facets FROM candidates WHERE q=? AND emitted IS NULL AND admitted=1 ${input.exact_only ? 'AND json_extract(data,\'$.exact\')>0' : ''}`).get(q) as any;
                // A sparse relevant yield is a per-page stopping suggestion, never exhaustion.
                lowGain = count.n > 0 && candidates.size >= 16 && count.n / candidates.size < .25;
                if (lowGain)
                    break;
                if (resolved === 'focused' && count.n >= Math.min(request.limit ?? input.limit ?? 8, config.page_item_limit))
                    break;
                if (resolved === 'broad' && count.n >= Math.min(request.limit ?? input.limit ?? 32, config.page_item_limit) && (count.facets >= 3 || Boolean(request.limit ?? input.limit)))
                    break;
            } while (!(progress.vectorDone && progress.ftsDone && progress.idDone) && work < config.page_candidate_budget && performance.now() - start < config.page_time_budget_ms);
            progress.warnings = [...new Set(warnings)];
            state.db.prepare('UPDATE queries SET progress=?,resolved=?,retrieval_mode=?,expires=? WHERE id=?').run(JSON.stringify(progress), resolved, retrievalMode, Date.now() + config.query_ttl_seconds * 1000, q);
        }
        let options = { limit: request.limit ?? input.limit ?? (resolved === 'focused' ? 8 : config.page_item_limit), token_budget: Math.min(request.token_budget ?? input.token_budget ?? config.response_token_budget, config.response_token_budget), max_bytes: Math.min(request.max_bytes ?? input.max_bytes ?? config.page_response_bytes, config.page_response_bytes), view: request.view ?? input.view ?? 'chunks' };
        if (savedPage) {
            const prior = parse(savedPage.options);
            for (const key of ['limit', 'token_budget', 'max_bytes', 'view'] as const)
                if (request[key] !== undefined && options[key] !== prior[key])
                    throw new MemoryError('CURSOR_PAGE_OPTIONS_MISMATCH');
            if (prior.max_bytes > config.page_response_bytes || prior.token_budget > config.response_token_budget || parse(savedPage.ids).length > config.page_item_limit)
                throw new MemoryError('CURSOR_PAGE_BUDGET_CHANGED');
            options = prior;
            d.cache_replay = true;
        }
        traceBudget=options.max_bytes;
        let pool: Candidate[] = [], selected: string[] = [];
        if (request.ids)
            selected = request.ids;
        else if (savedPage) {
            pool = parse(savedPage.ids);
            selected = pool.map(c => c.id);
        }
        else {
            const extra = input.exact_only ? "AND json_extract(data,'$.exact')>0" : '', sql = resolved === 'broad' ? `WITH diverse AS (SELECT *,row_number() OVER(PARTITION BY project,topic,period ORDER BY base DESC,id) facet_rank FROM candidates WHERE q=? AND emitted IS NULL AND admitted=1 ${extra}) SELECT data FROM diverse ORDER BY facet_rank,base DESC,id LIMIT ?` : `SELECT data FROM candidates WHERE q=? AND emitted IS NULL AND admitted=1 ${extra} ORDER BY base DESC,id LIMIT ?`;
            pool = (state!.db.prepare(sql).all(q, config.page_candidate_budget) as any[]).map(r => parse(r.data));
            if (!pool.length && (resolved==='broad'||channel==='lexical'||retrievalMode==='lexical_degraded')) {
                pool = (state!.db.prepare(`SELECT data FROM candidates WHERE q=? AND emitted IS NULL ${input.exact_only ? 'AND json_extract(data,\'$.exact\')>0' : ''} ORDER BY base DESC,id LIMIT 1`).all(q) as any[]).map(r => parse(r.data));
            }
            // Quality anchor: score the leading relevance prefix with the v0.3 window.
            // This limits scoring contributions for five leading positions, never candidate discovery.
            const anchors = (resolved==='broad'||answerIntent(input.query??'')==='unknown') && page === 0 ? (progress.anchors as string[]).map(id => pool.find(c => c.id === id)).filter((c): c is Candidate => !!c) : [];
            if (resolved === 'broad') {
                const counts = new Map<string, number>();
                for (const facet of ['project', 'topic', 'period', 'source'] as const) {
                    const keys = [...new Set(pool.map(c => c[facet]))];
                    for (const r of state!.db.prepare(`SELECT ${facet} value,count(*) n FROM candidates WHERE q=? AND emitted IS NOT NULL AND ${facet} IN (SELECT value FROM json_each(?)) GROUP BY ${facet}`).all(q, JSON.stringify(keys)) as any[])
                        counts.set(facet + ':' + r.value, r.n);
                }
                // Preserve the leading relevance prefix; diversify the remaining evidence, not facts away.
                pool = pool.filter(c => !anchors.some(a => a.id === c.id));
                const sorted: Candidate[] = [...anchors];
                for (const c of sorted)
                    for (const f of ['project', 'topic', 'period', 'source'] as const)
                        counts.set(f + ':' + c[f], (counts.get(f + ':' + c[f]) ?? 0) + 1);
                while (pool.length) {
                    pool.sort((a, b) => {
                        const value = (c: Candidate) => c.base * (1 + .18 * (['project', 'topic', 'period', 'source'] as const).reduce((n, f) => n + 1 / (1 + (counts.get(f + ':' + c[f]) ?? 0)), 0) / 4);
                        return Number(a.requiresCheck) - Number(b.requiresCheck) || value(b) - value(a) || a.id.localeCompare(b.id);
                    });
                    const c = pool.shift()!;
                    sorted.push(c);
                    for (const f of ['project', 'topic', 'period', 'source'] as const)
                        counts.set(f + ':' + c[f], (counts.get(f + ':' + c[f]) ?? 0) + 1);
                }
                pool = sorted;
            }
            else if (anchors.length)
                pool = [...anchors, ...pool.filter(c => !anchors.some(a => a.id === c.id))];
            if(resolved==='focused')pool.sort((a,b)=>Number(Boolean(a.answer?.referenceBackground))-Number(Boolean(b.answer?.referenceBackground)));
            selected = pool.map(c => c.id);
            if (resolved === 'focused' && !(request.limit ?? input.limit) && pool.length > 1) {
                const a = pool[0], b = pool[1], gap = a.base > 0 ? (a.base - b.base) / a.base : 0;
                if (a.admitted && (a.exact > 0 || a.reasons.length >= 2) && (gap > .25 || ((a.cosine ?? 0) - (b.cosine ?? 0) >= .18 && (a.cosine ?? 0) >= config.evidence_threshold + .1 && a.coverage >= .6)) && (b.cosine ?? 0) < config.evidence_threshold && b.coverage < .6)
                    selected = selected.slice(0, 1);
            }
        }
        const flags = new Map((db.prepare(`SELECT s.memory_id,(s.branch IS NOT NULL AND ? IS NULL OR s.commit_ref IS NOT NULL AND ? IS NULL OR s.environment IS NOT NULL AND ? IS NULL) requires_check FROM memory_search s WHERE ${eligible.sql} AND s.memory_id IN (SELECT value FROM json_each(?))`).all(input.context.branch ?? null, input.context.commit ?? null, input.context.environment ?? null, ...eligible.params, JSON.stringify(selected)) as any[]).map(r => [r.memory_id, r.requires_check]));
        if (savedPage && selected.some(id => !flags.has(id)))
            throw new MemoryError('CURSOR_STALE');
        if (state && !savedPage)
            for (const id of selected)
                if (!flags.has(id))
                    state.db.prepare('DELETE FROM candidates WHERE q=? AND id=?').run(q, id);
        selected = selected.filter(id => flags.has(id));
        if (!savedPage)
            selected.sort((a, b) => Number(flags.get(a)) - Number(flags.get(b)));
        d.candidate_ids = state ? Number((state.db.prepare('SELECT count(*) n FROM candidates WHERE q=?').get(q) as any).n) : selected.length;
        d.candidates_ranked = selected.length;
        const plan: any = savedPage ? parse(savedPage.plan) : { mode: request.ids ? 'ids' : resolved, assessment: 'heuristic', view: options.view, stop_reason: 'page_budget' };
        const result: any = { items: [], generation: gen, retrieval_mode: retrievalMode, warnings: [...new Set(warnings)], empty_reason: null, evidence_status: 'none', has_more: false, next_cursor: null, retrieval: plan };
        if(profileTrace)profileTrace.add('candidates',Math.max(0,performance.now()-candidateStarted-['knn','fts_identifiers','ranking','candidate_sql'].reduce((n,k)=>n+(profileTrace.times[k]??0),0)));
        const materializeStarted=performance.now();if(profileTrace)profileTrace.current='materialization';
        const fitted: string[] = [], candidateMap = new Map(pool.map(c => [c.id, c]));
        let blocked = false;
        const fits = (reserve = 256) => {const bytes=Buffer.byteLength(JSON.stringify(result))+reserve;return bytes<=options.max_bytes-(debug?Math.min(2048,Math.floor(options.max_bytes/2)):0)&&estimateTokens(bytes)<=options.token_budget;};
        for (const id of selected.slice(0, Math.min(options.limit, config.page_item_limit))) {
            const row = db.prepare(`SELECT s.revision,s.project_id,s.scope,s.profile_id,s.metadata,m.content_hash,m.written_by,m.verified_at${request.ids ? ',m.body' : ''} FROM memory_search s JOIN memories m ON m.id=s.memory_id WHERE s.memory_id=?`).get(id) as any;
            let body: any;
            if (request.ids) {
                d.full_body_records_read++;
                d.full_body_bytes_read += Buffer.byteLength(row.body);
                body = parse(row.body);
            }
            else
                body = parse(row.metadata, true);
            const c = candidateMap.get(id), ids = c?.hits.slice(0, options.view === 'evidence' ? 1 : 2).map(h => h[0]) ?? [];
            const loaded=request.ids?{rows:[],read:0}:readChunks(id,ids),chunks=loaded.rows;
            d.chunk_text_rows_read += loaded.read;
            const excerpts: any[] = [];
            let snippetSelection='chunk_fallback';
            for (const original of chunks) {
                const window=options.view==='evidence'?evidenceWindow(original.text,input.query??'',200):null;if(window)snippetSelection=window.selection;
                const x=window?{...original,start:original.start+window.start,end:original.start+window.end,text:window.text}:original;
                const last = excerpts.at(-1);
                if (last && x.start <= last.end) {
                    last.text += x.text.slice(Math.max(0, last.end - x.start));
                    last.end = Math.max(last.end, x.end);
                    last.chunk_ids.push(x.id);
                }
                else
                    excerpts.push({ start: x.start, end: x.end, text: x.text, chunk_ids: [x.id] });
            }
            if (request.ids)
                excerpts.push({ start: 0, end: body.content.length, text: body.content, chunk_ids: [] });
            if (options.view === 'evidence' && !request.ids) {
                for (const e of excerpts) {
                    e.text = e.text.slice(0, 200);
                    e.end = e.start + e.text.length;
                }
                excerpts.splice(1);
            }
            const referenceBackground=resolved==='focused'&&Boolean(c?.answer?.referenceBackground);
            const strength = request.ids || c && !referenceBackground && (c.exact > 0 || c.coverage >= .6 || (c.cosine ?? 0) >= config.evidence_threshold) ? 'supported' : 'weak';
            const item: any = { id, revision: row.revision, project_id: row.project_id, scope: row.scope, kind: body.kind, title: body.title, written_by: row.written_by, content: excerpts.map(e => e.text).join('\n…\n'), sources: body.sources, verification: verificationSchema.parse(body.verification), valid_for: body.valid_for ?? {}, applicability: flags.get(id) ? 'requires_check' : 'current', evidence_strength: strength, tags: body.tags, record_updated_at: row.verified_at, excerpt: { start: excerpts[0]?.start ?? 0, end: excerpts.at(-1)?.end ?? 0 }, excerpts: excerpts.map(({ text, ...e }) => e), recall_reason: c?.reasons ?? ['id'] };
            if (c?.answer) item.answer_relevance={state:c.answer.state,assessment:'local_claim_heuristic',intent:answerIntent(input.query??'')};
            if(referenceBackground){item.recall_reason=[...item.recall_reason,'background_only'];if(!result.warnings.includes('REFERENCE_EVIDENCE_MISSING'))result.warnings.push('REFERENCE_EVIDENCE_MISSING');}
            if (options.view==='evidence'&&!request.ids) item.snippet_selection=snippetSelection;
            if (request.ids)
                Object.assign(item, { written_by: row.written_by, content_hash: row.content_hash, embedding_profile_id: row.profile_id, derived_from: body.derived_from, author_client: body.author_client, author_session: body.author_session, import_key: body.import_key, relevance: c ? { rrf: c.rrf, cosine: c.cosine, identifier_matches: c.exact } : undefined });
            result.items.push(item);
            if (!fits()) {
                result.warnings.push('RESPONSE_BUDGET');
                if (result.items.length > 1) {
                    result.items.pop();
                    break;
                }
                // Truncate each actual segment; separator characters are not source offsets.
                const shorten = (length: number) => { let remaining = length; const parts: any[] = []; for (const e of excerpts) {
                    if (remaining <= 0)
                        break;
                    let text = e.text.slice(0, remaining);
                    if (/[\uD800-\uDBFF]$/.test(text))
                        text = text.slice(0, -1);
                    if (text)
                        parts.push({ ...e, text, end: e.start + text.length });
                    remaining -= text.length;
                } item.content = parts.map(e => e.text).join('\n…\n'); item.truncated = true; item.excerpts = parts.map(({ text, ...e }) => e); item.excerpt = { start: parts[0]?.start ?? 0, end: parts.at(-1)?.end ?? 0 }; };
                let lo = 1, hi = excerpts.reduce((n, e) => n + e.text.length, 0), best = 0;
                while (lo <= hi) {
                    const mid = Math.floor((lo + hi) / 2);
                    shorten(mid);
                    if (fits()) {
                        best = mid;
                        lo = mid + 1;
                    }
                    else
                        hi = mid - 1;
                }
                if (!best) {
                    result.items.pop();
                    result.blocked_ids = [id];
                    blocked = true;
                    break;
                }
                shorten(best);
            }
            fitted.push(id);
        }
        profileTrace?.add('materialization',performance.now()-materializeStarted);
        const persistStarted=performance.now();
        if (state) {
            state.db.prepare('UPDATE queries SET expires=? WHERE id=?').run(Date.now() + config.query_ttl_seconds * 1000, q);
            const done = progress.vectorDone && progress.ftsDone && progress.idDone;
            if (!savedPage) {
                for (const id of fitted)
                    state.db.prepare('UPDATE candidates SET emitted=? WHERE q=? AND id=?').run(page, q, id);
                const pending = Number((state.db.prepare(`SELECT count(*) n FROM candidates WHERE q=? AND emitted IS NULL AND admitted=1 ${input.exact_only ? "AND json_extract(data,'$.exact')>0" : ''}`).get(q) as any).n);
                const more = pending > 0 || !done;
                plan.stop_reason = blocked ? 'item_exceeds_budget' : !result.items.length ? 'insufficient' : !more ? 'exhausted' : lowGain ? 'low_marginal_gain' : !done && work >= config.page_candidate_budget ? 'candidate_budget' : !done && performance.now() - start >= config.page_time_budget_ms ? 'time_budget' : resolved === 'focused' && fitted.length === 1 ? 'low_marginal_gain' : 'page_budget';
                plan.more_unexamined = !done;
                const coverage = state.db.prepare('SELECT count(DISTINCT project) projects,count(DISTINCT period) periods,count(DISTINCT topic) topics FROM candidates WHERE q=? AND emitted IS NOT NULL').get(q);
                plan.coverage = coverage;
                result.has_more = more;
                result.next_cursor = more ? state.cursor(q, blocked ? page : page + 1) : null;
                if (!blocked)
                    state.db.prepare('INSERT INTO pages VALUES(?,?,?,?,?)').run(q, page, JSON.stringify(fitted.map(id => candidateMap.get(id))), JSON.stringify(options), JSON.stringify({ ...plan, has_more: more }));
            }
            else {
                result.has_more = plan.has_more;
                result.next_cursor = result.has_more ? state.cursor(q, page + 1) : null;
                delete plan.has_more;
            }
        }
        profileTrace?.add('state_persist',performance.now()-persistStarted);
        const serializationStarted=performance.now();
        result.evidence_status = result.items.some((i: any) => i.evidence_strength === 'supported') ? 'related_evidence' : 'insufficient';
        result.empty_reason = result.items.length ? null : blocked ? 'item_exceeds_budget' : 'no_relevant_evidence';
        d.elapsed_ms = Number((performance.now() - start).toFixed(3));
        d.content_estimated_tokens = estimateTokens(Buffer.byteLength(JSON.stringify(result)));
        if (debug) {
            result.diagnostics = d;
            for (let i = 0; i < 4; i++) {
                d.response_bytes = Buffer.byteLength(JSON.stringify(result));
                d.estimated_tokens = estimateTokens(d.response_bytes);
            }
        }
        if (Buffer.byteLength(JSON.stringify(result)) > options.max_bytes)
            throw new MemoryError('PAGE_BUDGET_TOO_SMALL');
        profileTrace?.add('serialization',performance.now()-serializationStarted);
        if(state)state.enforce(q);
        db.exec('COMMIT');
        const committing=performance.now();state?.commit();profileTrace?.add('state_persist',performance.now()-committing);
        if(profileTrace&&debug){profileTrace.add('total',performance.now()-start);Object.assign(d,{stages_ms:profileTrace.times,state_lock:state?.timing,memory:process.memoryUsage()});
            if(Buffer.byteLength(JSON.stringify(result))>options.max_bytes){delete (d as any).stages_ms;delete (d as any).state_lock;delete (d as any).memory;}
            for(let i=0;i<4;i++){d.response_bytes=Buffer.byteLength(JSON.stringify(result));d.estimated_tokens=estimateTokens(d.response_bytes);}
        }
        traceResponse=result;return result;
    }
    catch (e) {
        if (db.isTransaction)
            db.exec('ROLLBACK');
        state?.rollback();
        if(state && (e instanceof MemoryError && /QUERY_CACHE/.test(e.code) || e instanceof Error && /database or disk is full/i.test(e.message))) {
            try {state.rejected();}catch{}
            if(!(e instanceof MemoryError))throw new MemoryError('QUERY_CACHE_DISK_CAPACITY');
        }
        throw e;
    }
    finally {
        const closed=performance.now();state?.close();
        if(profileTrace&&traceResponse?.diagnostics){
            profileTrace.add('state_close',performance.now()-closed);profileTrace.times.total=performance.now()-start;
            if(Buffer.byteLength(JSON.stringify(traceResponse))>traceBudget){delete (d as any).stages_ms;delete (d as any).state_lock;delete (d as any).memory;}
            for(let i=0;i<4;i++){d.response_bytes=Buffer.byteLength(JSON.stringify(traceResponse));d.estimated_tokens=estimateTokens(d.response_bytes);}
        }
    }
}
