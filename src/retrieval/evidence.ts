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
const namedReferences=(query:string)=>[...new Set([...identifiers(query),...(query.match(/[\p{L}\p{N}]+(?:[_-][\p{L}\p{N}]+)+|\b[A-Z]{2,}\d*\b/gu)??[]).map(x=>x.toLowerCase())])];
// References constrain what a hit can support, not what the semantic channel may find.
// Calendar dates are context; numeric error codes and named code/path references remain evidence.
export function referenceEvidence(query:string) {
    const refs=namedReferences(query)
        .filter(x=>!/^20\d{2}(?:\d{4}|[-_]\d{1,2}[-_]\d{1,2})?$/.test(x));
    const referenceTerms=new Set(refs.flatMap(terms)),subject=focusTerms(query).filter(t=>!referenceTerms.has(t));
    const patterns=refs.map(id=>referencePattern(id,true));
    return (text:string,words=new Set(terms(text)))=>({count:refs.length,coverage:refs.length?patterns.filter(re=>re.test(text)).length/refs.length:1,subjectCoverage:subject.length?subject.filter(t=>words.has(t)).length/subject.length:0});
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
