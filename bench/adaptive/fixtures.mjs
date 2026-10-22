// Frozen, auditable fictional history. Relevance comes from the scenario, not retrieval output.
// 120 queries (10 groups x 12), graded multi-answer labels, no user memories.
import {createHash} from 'node:crypto';
export const projects=Array.from({length:6},(_,i)=>`a0000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
export const memories=[],queries=[];
const add=(key,title,content,extra={})=>{const i=memories.length;memories.push({key,project:projects[i%6],kind:'procedure',title,content,tags:[],date:`2025-${String(i%12+1).padStart(2,'0')}-15T00:00:00.000Z`,basis:'source_claim',...extra});return key;};
const query=(category,text,keys,extra={})=>queries.push({id:`${category}-${queries.filter(q=>q.category===category).length+1}`,category,query:text,mode:'focused',relevant:Object.fromEntries(keys.map(k=>[k,2])),...extra});
const technical=[
 ['SQLite 写锁','缩短写事务，把嵌入编码与网络请求移到事务外，针对 SQLITE_BUSY 采用有界退避。','SQLITE_BUSY','src/storage/database.ts','retryTransaction()','多人同时保存时数据库被锁住，之前怎么解决？'],
 ['中文字体方框','输出文档汉字变方框时核对字体的中文字形和嵌入设置。','ERR_FONT_GLYPH','src/export/fonts.ts','embedFonts()','导出报告的汉字成小方块，应检查哪里？'],
 ['macOS 录屏授权','重新构建后保持签名身份稳定，再在系统设置重授录屏权限。','ERR_TCC_DENIED','src/capture/permission.ts','checkCapture()','更新程序后突然不能截图，过去有什么排查方法？'],
 ['上传校验失败','传输前后核对文件摘要，不一致保留原件并重传，核验成功前不删本地文件。','ERR_HASH_MISMATCH','src/upload/checksum.ts','verifyUpload()','上传完如何防止损坏或者提前丢掉原件？'],
 ['请求幂等','客户端重试复用逻辑请求 ID，服务端存储请求回执以避免重复创建。','ERR_DUPLICATE_REQUEST','src/api/receipts.ts','deduplicateRequest()','网络超时再发一次时如何避免保存两份？'],
 ['版本冲突','提交修改携带读取到的 Revision，冲突后重新读取并让操作者决定。','ERR_REVISION_CONFLICT','src/core/revision.ts','checkRevision()','两人编辑同一记录时怎样防止覆盖别人修改？'],
 ['音频对齐','先统一采样率，再使用明显声峰对齐多个机位的声画。','ERR_AUDIO_DRIFT','src/media/sync.ts','alignTracks()','几台相机拍出的嘴型错开了，以前怎么校准？'],
 ['模型损坏','模型文件校验失败时明确报告词法降级，修复模型后核对索引配置。','ERR_MODEL_HASH','src/embedding/model.ts','verifyModel()','语义模型打不开时搜索服务应该怎么办？'],
 ['手机横向溢出','检查固定宽度、长代码块和容器 min-width，使用窄屏预览核验。','ERR_LAYOUT_OVERFLOW','src/ui/layout.ts','measureOverflow()','手机网页左右被撑开应该查哪些限制？'],
 ['备份恢复撤销','恢复旧备份前应用最新遗忘撤销清单，避免已遗忘内容复活。','ERR_REVOCATION_REQUIRED','src/backup/restore.ts','applyRevocations()','恢复历史数据时如何避免已经删除的信息重新出现？'],
 ['HTTPS 摄像头','手机浏览器摄像头需要安全上下文和站点授权，使用可信 HTTPS 入口。','ERR_INSECURE_CAMERA','src/web/camera.ts','openCamera()','手机网页调不起相机，以前排查过什么？'],
 ['时区偏移','安排跨地区日程保存 IANA 时区，不把服务器日期当作用户当地日期。','ERR_TIMEZONE_OFFSET','src/time/schedule.ts','localSchedule()','提醒时间差了八小时应该如何修正？']
];
for(const [i,t]of technical.entries()){
 const [topic,fix,code,path,fn,paraphrase]=t,keys=[`tech-${i}-fix`,`tech-${i}-review`];
 add(keys[0],topic+'操作记录',`${fix} 当时日志：${code}；修改位置 ${path}，函数 ${fn}。`,{tags:[topic]});
 add(keys[1],topic+'复核结果',`在另一个应用中复核：${fix} 此记录为独立复现，保留来源差异。`,{tags:[topic],basis:'code_review'});
 add(`tech-${i}-negative`,topic+'未实施提案',`曾有人建议遇到 ${code} 直接跳过校验，讨论后否决；这里没有已采用的修复流程。`,{tags:['否决提案']});
 query('technical',`${code} 上次采用的修复和复核办法是什么？`,keys);
 query('paraphrase',paraphrase,keys);
 query('symbols',i%2?`${path} 的 ${fn} 为什么要修改？`:`${fn} 在 ${path} 的处理约定`,[keys[0]]);
 query('cross_project',`跨项目查找「${topic}」的处理经验及验证记录`,keys,{mode:'broad'});
}
const preferences=[
 ['排版','设计偏好：正文采用易读字体，标题层次清楚，控制密度。','阅读应用这次明确要求正文用宋体并增大行距。'],
 ['配色','设计偏好：日常界面低饱和配色，少量强调色。','工具页面把大面积荧光渐变改成灰白底，只保留状态色。'],
 ['动效','设计偏好：动效简洁，用来解释状态变化，减少无意义弹跳。','这次宣传片需要强烈节奏和快速切换，仅用于活动开场。'],
 ['手机布局','设计偏好：手机界面可以单手操作，窄屏无横向滚动。','读书页在小屏保留字号、笔记和续读入口。'],
 ['信息层级','设计偏好：每屏只强调一个主要操作，信息层次清晰。','报表页把三个抢眼按钮收敛成一个主动作。'],
 ['材质','设计偏好：材质服务内容，减少厚重阴影和无用途玻璃效果。','展览场景这次需要反光金属和玻璃，属于主题限定。']
];
export const preferenceKeys=[];
for(let i=0;i<72;i++){
 const [theme,principle,instance]=preferences[i%6],basis=i%4===0?'model_inference':i%4===1?'source_claim':'user_confirmation';
 const qualification=basis==='model_inference'?'模型推测，用户尚未确认，不能当作稳定偏好。':basis==='source_claim'?'这是行为选择的记录，不能单凭一次选择推断长期偏好。':'用户明确表达；仍需结合时间和场景，不代表永久不变。';
 const key=add(`design-${i}`,`设计偏好证据：${theme}／项目阶段${Math.floor(i/6)+1}`,`${principle} ${instance} ${qualification} ${i%5===0?'后来用户提出反例，保留前后差异，不消除矛盾。':''}`,{kind:i%3===0?'decision':'preference',project:projects[Math.floor(i/6)%6],tags:['设计',theme],basis,date:`${2024+Math.floor(i/36)}-${String(i%12+1).padStart(2,'0')}-15T00:00:00.000Z`});preferenceKeys.push(key);
}
const broadQuestions=['根据过去不同项目和讨论，有哪些设计偏好？','长期审美取向有哪些反复出现的证据和反例？','跨时间总结界面设计习惯，哪些明确说过、哪些只是推断？','多项目的视觉方案修改意见反映了什么选择？','设计方案中被否定和保留的东西有哪些？','请检索设计偏好，保留临时要求和长期倾向的区别。','梳理不同年份的设计选择，寻找变化和冲突。','找齐有关用户审美和设计工作方式的历史证据。','哪些设计习惯在多个情境重复出现？','分析设计偏好前，先提供可以审查的来源和反例。','希望了解长期视觉偏好，请跨项目找材料。','不要只看最接近的几条，查阅设计决策的完整历史。'];
broadQuestions.forEach(text=>query('preferences',text,preferenceKeys,{mode:'broad'}));
broadQuestions.forEach(text=>query('pagination',text+' 分页取得所有相关设计证据。',preferenceKeys,{mode:'broad',view:'evidence',limit:7}));
for(let i=0;i<12;i++){
 const [theme]=preferences[i%6],keys=preferenceKeys.filter((_,n)=>n%6===i%6);
 query('similar_neighbors',`${i%2?'寻找':'回顾'}关于${theme}的设计要求，包括相反意见和临时例外`,keys,{mode:'broad'});
 const active=add(`conflict-${i}-current`,`导出策略${i}当前约定`,`${technical[i][0]}在当前正式环境应遵循已复核的流程：${technical[i][1]}`,{valid_for:{environment:'production'},tags:['导出策略']});
 add(`conflict-${i}-expired`,`导出策略${i}旧约定`,`已停止采用：${technical[i][0]}可跳过检查。`,{valid_for:{expires_at:'2020-01-01T00:00:00.000Z'}});
 add(`conflict-${i}-dev`,`导出策略${i}实验约定`,`${technical[i][0]}允许在开发环境模拟失败，不能用于正式环境。`,{valid_for:{environment:'development'}});
 query('conflicts',`导出策略${i}关于${technical[i][0]}在正式环境当前约定是什么？`,[active],{context:{environment:'production'}});
 query('multi_evidence',`综合${technical[i][0]}和${technical[(i+1)%12][0]}的修复办法与复核来源`,[`tech-${i}-fix`,`tech-${i}-review`,`tech-${(i+1)%12}-fix`,`tech-${(i+1)%12}-review`],{mode:'broad'});
}
const absent=['火星矿场风暴预警','冰岛鲸鱼追踪声呐','量子霍尔拓扑实验','潜水减压舱故障','巴洛克竖琴调弦','南极企鹅迁徙','地铁盾构注浆压力','稻田病虫害测绘','卫星轨道交会','古埃及碑文释读','核磁共振线圈维修','橄榄油压榨温度'];
absent.forEach(x=>query('no_answer',`${x}过去采取过什么处理？`,[]));
for(let i=0;i<96;i++)add(`distractor-${i}`,['花圃登记','仓储盘点','食堂菜单','物流清单'][i%4]+i,`批次${i}独立登记清单，分区${i%9}数量${i%17}，不涉及用户设计偏好或技术排错。`,{tags:['行政']});
if(queries.length!==120)throw Error('Fixture must contain 120 queries');
export const fingerprint=createHash('sha256').update(JSON.stringify({projects,memories,queries})).digest('hex');
