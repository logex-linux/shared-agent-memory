// Rule-generated specialist scenarios; labels are authored from scenarios, never model scores.
// Neither independent human annotation nor real-world retrieval accuracy is claimed.
import {createHash} from 'node:crypto';
export const projects=Array.from({length:6},(_,i)=>`b0000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
export const memories=[],queries=[];
const add=(key,title,content,extra={})=>{memories.push({key,project:projects[memories.length%6],kind:'procedure',title,content,tags:[],date:'2025-02-01T00:00:00.000Z',basis:'source_claim',...extra});return key;};
const q=(id,category,query,keys,extra={})=>queries.push({id,category,query,mode:'focused',view:'evidence',relevant:Object.fromEntries(keys.map(k=>[k,2])),...extra});
const subjects=[['SQLITE_BUSY','写锁','缩短写事务并采用有界重试'],['ERR_HASH_MISMATCH','上传校验','核对摘要并保留原件重传'],['ERR_TCC_DENIED','截图授权','保持签名稳定并重新授权'],['ERR_AUDIO_DRIFT','声画同步','统一采样率后按声峰对齐'],['ERR_MODEL_HASH','模型加载','校验模型并明确词法降级'],['ERR_REVISION_CONFLICT','编辑冲突','重读 Revision 后由操作者处理差异'],['ERR_INSECURE_CAMERA','手机相机','使用可信 HTTPS 并检查站点授权'],['ERR_TIMEZONE_OFFSET','日程偏移','保存 IANA 时区并核对当地日期']];
for(const [i,[code,topic,fix]] of subjects.entries()){
 const adopted=add(`case-${i}-adopted`,`${topic}处理记录`,`${'背景材料：登记日期和测试机器，等待后续排查。'.repeat(9)}\n我们最终采用了${fix}。故障 ${code}，修改 src/case-${i}/repair.ts 的 repairCase${i}()。\n测试日志已附来源；这只是该项目执行记录。`,{tags:[topic],basis:'code_review'});
 const review=add(`case-${i}-review`,`${topic}独立复核`,`${code} 的独立复核：${fix}。此复现有测试日志，适用本机环境。`,{tags:[topic],basis:'code_review'});
 const rejected=add(`case-${i}-rejected`,`${code}最终修复候选讨论`,`${code} 最终修复讨论：有人提出关闭全部校验；团队明确否决该方案，没有采用。${topic}仅为讨论主题，不能当作执行证据。`,{tags:[topic]});
 add(`case-${i}-proposed`,`${code}待执行建议`,`尚未实施的建议：为 ${code} 尝试关闭检查，尚未执行。`,{tags:[topic]});
 add(`case-${i}-inference`,`${topic}可能已解决`,`模型推测：我们最终采用了${fix}解决 ${code}，没有执行日志，用户尚未确认。`,{tags:[topic],basis:'model_inference'});
 add(`case-${i}-old`,`${topic}旧流程`,`${code} 的旧流程已经被修订版取代；旧做法是直接跳过检查。`,{tags:[topic]});
 add(`case-${i}-background`,`${code}登记`,`${code} ${topic} 故障登记。设备编号和日期，尚未定位原因，没有修复方案。`,{tags:[topic]});
 add(`case-${i}-other-root`,`${code}另一个项目原因`,`${code} 在另一个项目只是测试夹具故意抛错，解决方法是关闭模拟开关。没有采用本项目${topic}的流程。`,{tags:['模拟故障']});
 add(`case-${i}-expired`,`${topic}过期经验`,`${code} 可直接删除校验。`,{valid_for:{expires_at:'2020-01-01T00:00:00.000Z'}});
 q(`adopt-${i}`,'adopted',`之前 ${code} 最终实际采用了什么办法？`,[adopted,review],{adopted,rejected,targets:{[adopted]:`我们最终采用了${fix}。`,[review]:fix}});
 q(`rejected-${i}`,'rejected',`${code} 关闭全部校验的方案是否被否决？`,[rejected],{targets:{[rejected]:'团队明确否决该方案'}});
 q(`late-${i}`,'late_chunk',`src/case-${i}/repair.ts 的 repairCase${i}() 修改记录`,[adopted],{targets:{[adopted]:`src/case-${i}/repair.ts`}});
 q(`semantic-${i}`,'semantic',`${topic}以前采用什么处理？保留不同来源的复核。`,[adopted,review]);
 q(`multi-${i}`,'multiple_sources',`跨项目汇总 ${code} ${topic} 的已执行记录、独立复核以及被否决的方案`,[adopted,review,rejected],{mode:'broad'});
 q(`absent-${i}`,'no_answer',`${['火星矿场','极地声呐','竖琴调弦','量子霍尔','盾构注浆','鲸鱼迁徙','碑文释读','稻田病虫害'][i]}具体采用的修复是什么？`,[]);
}
const prefs=[];
for(let i=0;i<54;i++)prefs.push(add(`pref-${i}`,`界面偏好来源${i}`,i%3===0?'用户明确说：正文要易读，页面层次清楚。':i%3===1?'这次项目要求快节奏动画，仅用于开场；此前要求减少弹跳，保留矛盾。':'模型推测用户总喜欢灰白界面，尚未获用户确认。',{kind:'preference',tags:['设计',i%3===0?'排版':i%3===1?'动效':'配色'],basis:i%3===2?'model_inference':'user_confirmation',date:`${2023+i%3}-${String(i%12+1).padStart(2,'0')}-01T00:00:00.000Z`}));
for(let i=0;i<12;i++)q(`prefs-${i}`,'preferences',`跨项目长期设计偏好有哪些明确表态、临时例外和模型推断？${i%2?'保留反例与时间差异。':''}`,prefs,{mode:'broad',limit:7});
export const fingerprint=createHash('sha256').update(JSON.stringify({projects,memories,queries})).digest('hex');
