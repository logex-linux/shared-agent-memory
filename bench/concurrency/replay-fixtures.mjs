// Sanitized shapes from the v0.4.6 call audit, with fictional paths and source data.
// These labels are auditable rules, not independent human accuracy measurements.
import{createHash}from'node:crypto';
export const projects=['12345678-1234-4234-8234-123456789abc','22345678-1234-4234-8234-123456789abc'];
const base={project:projects[0],kind:'fact',tags:['work'],date:'2026-01-01T00:00:00.000Z',basis:'document_review'};
export const memories=[
 {...base,key:'folders',title:'开发目录分类规则',content:'/workspace/dev 的目录结构按用途分类整理，收纳习惯是应用、工具、研究和归档分开保存。',tags:['folders']},
 {...base,key:'reading',title:'全书拆解稿的位置与来源',content:'课程文稿的全书拆解笔记使用 Markdown 文件保存，按章节定位，保留来源TXT及图版说明。继续阅读时核对当前文件版本。',valid_for:{environment:'reading-workspace'},tags:['reading']},
 {...base,key:'module',title:'Artifact Session 相对MJS导入报错的替代路径',content:'Artifact Session 演示文稿使用静态相对MJS导入带查询参数时报 Module not found。先由本地Node导出JSON，再通过fs.readFile读取JSON后成功提交，避免模块缓存阻碍更新。',valid_for:{environment:'artifact-runtime'},tags:['modules']},
 {...base,key:'course',title:'课程诊断修复与来源边界',content:'个人CS合并大课程诊断六项修复：保留题面版本、备份历史、复习记录与来源路径；运行通过不代表全库学术认证。',valid_for:{environment:'course-local'},tags:['courses']},
 ...Array.from({length:6},(_,i)=>({...base,project:projects[i%2],key:'background-'+i,title:'Imported work /workspace/dev '+i,content:'cwd: /workspace/dev\nInstalled a local runtime and tested startup. Other historical topics and previous task summaries.',tags:['historical','raw_memories']}))
];
export const queries=[
 {id:'audit-folders',category:'sanitized-audit',mode:'auto',query:'/workspace/dev 目录结构 分类整理 收纳习惯',relevant:{folders:1}},
 {id:'audit-reading',category:'sanitized-audit',mode:'focused',query:'课程文稿 全书拆解 笔记 Markdown 文件 来源TXT 图版和章节定位',relevant:{reading:1}},
 {id:'audit-module',category:'sanitized-audit',mode:'focused',query:'Artifact Session 演示文稿 静态相对导入 MJS 查询参数 Module not found 读取JSON 避免模块缓存',relevant:{module:1}},
 {id:'audit-course',category:'sanitized-audit',mode:'focused',query:'个人CS合并大课程 诊断六项修复 题面版本 备份历史 复习记录 来源路径',relevant:{course:1}},
 {id:'audit-no-evidence',category:'sanitized-audit',mode:'focused',query:'ZX_UNRECORDED 专属密码轮转的实际执行结论',relevant:{}},
 {id:'audit-broad',category:'sanitized-audit',mode:'broad',query:'跨项目总结 /workspace/dev 的工作与目录分类经验',relevant:{folders:1,'background-0':1,'background-1':1,'background-2':1,'background-3':1,'background-4':1,'background-5':1}}
];
export const fingerprint=createHash('sha256').update(JSON.stringify({projects,memories,queries})).digest('hex');
