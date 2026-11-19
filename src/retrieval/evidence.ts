import { identifiers, terms } from './lexical.js';
// Query scaffolding is not subject evidence. Broad uses its existing lexical channel.
const scaffolding = new Set(terms('上次 最终 采用 修复 复核 办法 之前 过去 为什么 修改 处理 当前 正式 环境 记录 方案 解决 当时 执行 实施 建议 提案 否决 实际 查找 查 找 怎样 应 当 已经 什么 哪些 能够 验证 结果 原因 什么办法 adopted implemented proposed rejected solution previously final fix review a an the and or but of to for from in on at by with as is are was were be been being have has had do does did this that these those it its i we you they their our my your which what how why when where who should would could can must may will not no if then than also into about through during before after including exactly explicitly said made current previous user'));
export const focusTerms = (query: string) => terms(query).filter(t => !scaffolding.has(t));
export type FactState = 'implemented'|'proposed'|'rejected'|'disputed'|'superseded'|'unknown';
export function answerIntent(query: string) {
    if (/否决|拒绝|放弃|rejected|ruled out/i.test(query)) return 'rejected';
    if (/建议|提案|可选|propos|suggest/i.test(query)) return 'proposed';
    if (/采用|实施|执行|最终|上次.*解决|implemented|adopted|actually|ultimately/i.test(query)) return 'implemented';
    return 'unknown';
}
// These are explicit local claims, not factual verification. Ambiguous/mixed language stays unknown.
export function factState(text: string, basis: string, disputed = false): FactState {
    if (disputed) return 'disputed';
    if (basis === 'model_inference') return 'unknown';
    const rejected = /(?:讨论后|明确|已经|已|最终)?(?:否决|拒绝采用|放弃该方案)|\b(?:rejected|ruled out)\b/i.test(text);
    const proposed = /未实施|尚未(?:执行|实施)|仅(?:为|是)?建议|建议(?:尝试|采用)|\b(?:proposed|suggested)\b/i.test(text);
    // Require an affirmative, attributed execution statement, not the word "implemented" alone.
    const implemented = /(?:我们|团队|用户|维护者|实际|最终|当时)(?:已经|已|最终)?(?:采用了|实施了|部署了|执行了)|\b(?:we|the team|maintainers) (?:actually |finally |have )?(?:implemented|adopted|deployed)\b/i.test(text);
    const superseded = /(?:已被|已经被).{1,60}(?:替代|取代)|\bwas superseded by\b/i.test(text);
    if (Number(rejected)+Number(implemented)+Number(superseded)>1) return 'unknown';
    if (superseded) return 'superseded';
    if (rejected) return 'rejected';
    if (implemented && !/未采用|没有采用|not adopted|not implemented/i.test(text)) return 'implemented';
    if (proposed) return 'proposed';
    return 'unknown';
}
// Han prose may touch an ASCII reference; identifier extensions still cannot match.
function referencePattern(id:string,pathSuffix=false) {
    const value=pathSuffix?id.replace(/^\//,''):id;
    const left='(^|[^\\p{L}\\p{N}_./@-]'+(/^\p{Script=Han}/u.test(value)?'':'|\\p{Script=Han}')+(pathSuffix&&id.includes('/')?'|/':'')+')';
    const right='(?=$|[^\\p{L}\\p{N}_./@-]'+(/\p{Script=Han}$/u.test(value)?'':'|\\p{Script=Han}')+'|\\.(?=\\s|$))';
    return new RegExp(left+value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+right,'iu');
}
function identifierAt(text:string,id:string) {
    const m=referencePattern(id).exec(text);
    return m?m.index+m[1].length:-1;
}
const namedReferences=(query:string)=>[...new Set([...identifiers(query),...(query.match(/[\p{L}\p{N}]+(?:[_-][\p{L}\p{N}]+)+|\b[A-Z]{2,}\d*\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/gu)??[]).map(x=>x.toLowerCase())])];
// References constrain what a hit can support, not what the semantic channel may find.
// Calendar dates are context; numeric error codes and named code/path references remain evidence.
export function referenceEvidence(query:string) {
    const refs=namedReferences(query)
        .filter(x=>!/^20\d{2}(?:\d{4}|[-_]\d{1,2}[-_]\d{1,2})?$/.test(x));
    const referenceTerms=new Set(refs.flatMap(terms)),subject=focusTerms(query).filter(t=>!referenceTerms.has(t));
    const patterns=refs.map(id=>referencePattern(id,true));
    return (text:string,words=new Set(terms(text)))=>({count:refs.length,coverage:refs.length?patterns.filter(re=>re.test(text)).length/refs.length:1,subjectCount:subject.length,subjectCoverage:subject.length?subject.filter(t=>words.has(t)).length/subject.length:0});
}
export type SupportLevel = 'direct'|'partial'|'missing';
export type SupportEntity = { anyOf: string[]; kind: 'path'|'code'|'name'|'term'|'number' };
export type SupportRequirement = { entities: SupportEntity[]; relations: { test: RegExp; label: string }[]; subject: string[] };
export type SupportAssessment = { level: SupportLevel; basis: string[]; subject_coverage: number; entities_covered: number; entities_required: number; relation_covered: boolean };
export type SupportSignal = { exact: number; coverage: number; cosine: number; threshold: number; referenceBackground?: boolean; subjectCoverage: number };
const englishScaffolding=new Set('the a an and or but of to for from in on at by with as is are was were be been being have has had do does did this that these those it its i we you they their our my your which what how why when where who should would could can must may will not no if then than also into about through during before after including exactly explicitly said made current previous user use using check find fix'.split(' '));
const relationRules=[
    {test:/共享|共用|同一(?:个)?|相同|一致|符号链接|软链接|硬链接|互指|链接到|指向|symlink|shared?|same(?: folder| directory)?|identical|link(?:ed)? to/i,label:'share_or_link'},
    {test:/区别|差异|不同|对比|比较|versus|\bvs\b|differ/i,label:'compare'},
    {test:/冲突|矛盾|不一致|contradict|conflict/i,label:'conflict'},
    {test:/依赖|取决于|depends? on/i,label:'depend'},
    {test:/替换|取代|迁移|改为|supersed|replac|migrat/i,label:'supersede'}
];
const normalizeEntity=(value:string)=>value.trim().replace(/^[`'"「『]+|[`'"」』]+$/g,'').toLowerCase();
// Entity and relation requirements are answerability checks, not recall filters.
// A person number or a shared public path remains a useful clue but cannot alone
// establish that the returned record answers the requested subject or relation.
export function supportRequirements(query:string):SupportRequirement {
    const entities=new Map<string,SupportEntity>(),add=(values:string[],kind:SupportEntity['kind'])=>{
        const anyOf=[...new Set(values.map(normalizeEntity).filter(value=>value.length>=2&&!englishScaffolding.has(value)))];
        const key=anyOf.join('|');
        if(anyOf.length&&!entities.has(key)) entities.set(key,{anyOf,kind});
    };
    const slashGroups=[...query.matchAll(/(?<![\p{L}\p{N}_/.-])([\p{L}\p{N}_+-]{2,})\s*[/／]\s*([\p{L}\p{N}_+-]{2,})(?![\p{L}\p{N}_/.-])/gu)]
        .map(match=>[match[1],match[2]]);
    const isPath=(id:string)=>id.startsWith('/')||id.startsWith('./')||id.startsWith('../')||id.includes('\\')||
        (id.match(/\//g)??[]).length>1||/\/[^/]*\.[a-z0-9]+$/i.test(id);
    const found=identifiers(query);
    const paths=found.filter(isPath);
    for(const path of paths) add([path],'path');
    const numbers=found.filter(id=>/^\d{4,}$/.test(id)&&!/^20\d{2}(?:\d{4}|[-_]\d{1,2}[-_]\d{1,2})?$/.test(id));
    const slashText=new Set(slashGroups.map(group=>group.join('/').toLowerCase()));
    const codes=found.filter(id=>!paths.includes(id)&&!numbers.includes(id)&&!slashText.has(id)&&
        !/^20\d{2}(?:\d{4}|[-_]\d{1,2}[-_]\d{1,2})?$/.test(id));
    for(const code of codes) add([code],'code');
    const quoted=[...query.matchAll(/[`'"「『]([^`'"」』]{2,80})[`'"」』]/g)].map(match=>match[1]);
    for(const value of quoted) add([value],'code');
    const names=[...query.matchAll(/\b[A-Z][A-Za-z0-9.+#_-]{2,}\b/g)].map(match=>match[0])
        .filter(value=>!englishScaffolding.has(value.toLowerCase())&&!/[_.-]$/.test(value)&&
            !paths.some(path=>path.includes(value.toLowerCase()))&&!codes.some(code=>code.includes(value.toLowerCase())));
    for(const name of names) add([name],'name');
    for(const group of slashGroups) add(group,'term');
    const groups=[...entities.values()];
    const same=(a:SupportEntity,b:SupportEntity)=>a.anyOf.length===b.anyOf.length&&a.anyOf.every(value=>b.anyOf.includes(value));
    const required=groups.filter((entity,index)=>!groups.some((other,otherIndex)=>otherIndex!==index&&
        (same(entity,other)&&otherIndex<index||
        other.anyOf.length>entity.anyOf.length&&entity.anyOf.every(value=>other.anyOf.includes(value)))));
    const referenceTerms=new Set(required.flatMap(entity=>entity.anyOf.flatMap(terms)));
    const subject=focusTerms(query).filter(term=>!referenceTerms.has(term));
    return {entities:required.slice(0,8),relations:relationRules.filter(rule=>rule.test.test(query)),subject};
}
const mentions=(text:string,value:string)=>{
    try {return referencePattern(value,/[\\/]/.test(value)).test(text);}
    catch {return text.toLowerCase().includes(value);}
};
export function supportAssessment(requirements:SupportRequirement,text:string,words:Set<string>,signal:SupportSignal):SupportAssessment {
    const entitiesRequired=requirements.entities.length;
    const covered=requirements.entities.filter(entity=>entity.anyOf.some(value=>mentions(text,value)));
    const entitiesCovered=covered.length;
    const relationCovered=!requirements.relations.length||requirements.relations.some(rule=>rule.test.test(text));
    const basis:string[]=[];
    const lexical=signal.coverage>=.6, semantic=signal.cosine>=signal.threshold, identifier=signal.exact>0;
    const strongSubject=signal.subjectCoverage>=.6;
    const missingKinds=requirements.entities.filter(entity=>!covered.includes(entity)).map(entity=>entity.kind);
    // A missing code symbol does not erase a locally supported subject. Missing
    // product names, vendors or paths do, unless the subject itself is fully covered.
    const entitiesOk=entitiesCovered===entitiesRequired
        || strongSubject&&missingKinds.every(kind=>kind==='code'||kind==='number');
    if(signal.referenceBackground) {
        basis.push('background_only');
        return {level:identifier||lexical||semantic?'partial':'missing',basis,subject_coverage:signal.subjectCoverage,entities_covered:entitiesCovered,entities_required:entitiesRequired,relation_covered:relationCovered};
    }
    if(!identifier&&!lexical&&!semantic) {
        basis.push('no_support_signal');
        return {level:'missing',basis,subject_coverage:signal.subjectCoverage,entities_covered:entitiesCovered,entities_required:entitiesRequired,relation_covered:relationCovered};
    }
    if(!entitiesOk) basis.push('missing_entity');
    else if(entitiesRequired&&entitiesCovered<entitiesRequired) basis.push('code_symbol_optional');
    if(!relationCovered) basis.push('missing_relation');
    const identifierSupport=identifier&&(strongSubject||!requirements.subject.length);
    const semanticSupport=semantic&&(strongSubject||entitiesRequired>0&&entitiesCovered===entitiesRequired||
        missingKinds.every(kind=>kind==='code'||kind==='number')&&signal.subjectCoverage>=.4);
    if(entitiesOk&&relationCovered&&(identifierSupport||lexical||semanticSupport)) {
        if(identifierSupport) basis.push('identifier_subject');
        if(lexical) basis.push('lexical_subject');
        if(semanticSupport) basis.push('semantic_subject');
        return {level:'direct',basis,subject_coverage:signal.subjectCoverage,entities_covered:entitiesCovered,entities_required:entitiesRequired,relation_covered:relationCovered};
    }
    if(!strongSubject) basis.push('weak_subject');
    return {level:'partial',basis,subject_coverage:signal.subjectCoverage,entities_covered:entitiesCovered,entities_required:entitiesRequired,relation_covered:relationCovered};
}
// Whole original sentence/line when possible. Long code lines use contiguous windows.
// Offsets are JS UTF-16 offsets, the same units used by the chunker.
export function evidenceWindow(text: string, query: string, budget = 200) {
    const ids = namedReferences(query), qt = focusTerms(query), lower = text.toLowerCase();
    const units: { start:number; end:number; score:number; match:number|null }[] = [];
    const re = /[^。！？.!?\n]+(?:[。！？.!?]+|\n|$)|[\n。！？.!?]+/g;
    for (const m of text.matchAll(re)) {
        const start=m.index!, end=start+m[0].length, words=new Set(terms(m[0]));
        const exact=ids.filter(id=>identifierAt(m[0],id)>=0);
        const matches=qt.filter(t=>words.has(t));
        const positions=[...exact,...matches].map(t=>lower.indexOf(t,start)).filter(p=>p>=start&&p<end);
        units.push({start,end,score:exact.length*8+matches.length,match:positions.length?Math.min(...positions):null});
    }
    // Literal matching across sentence punctuation (e.g. path dots / function names).
    for (const id of ids) { const at=identifierAt(text,id); if(at>=0) {
        const start=Math.max(0,text.lastIndexOf('\n',at)+1), next=text.indexOf('\n',at), end=next<0?text.length:next+1;
        units.push({start,end,score:8+qt.filter(t=>text.slice(start,end).toLowerCase().includes(t)).length,match:at});
    } }
    units.sort((a,b)=>b.score-a.score||a.start-b.start);
    const best=units[0]??{start:0,end:text.length,score:0,match:null};
    let start=best.start,end=best.end;
    if(end-start>budget) {
        start=Math.max(best.start,Math.min((best.match??best.start)-Math.floor(budget/4),best.end-budget));end=Math.min(best.end,start+budget);
    } else {
        // Adjacent context may help, but cannot displace the selected evidence.
        const room=budget-(end-start), before=Math.min(start,Math.floor(room/3));start-=before;end=Math.min(text.length,end+room-before);
    }
    if(start>0&&/[\uDC00-\uDFFF]/.test(text[start]))start++;
    if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;
    return {start,end,text:text.slice(start,end),selection:best.score>0?'query_window':'chunk_fallback'};
}
