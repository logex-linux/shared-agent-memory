// Generate only into a dedicated output directory; never merge user settings.
import {mkdir,readFile,writeFile,realpath,stat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2),option=(key,fallback)=>{const i=args.indexOf('--'+key);return i<0?fallback:args[i+1];};
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),configPath=resolve(option('config','.local/runtime/config.json')),output=resolve(option('output','docs/clients'));
const config=JSON.parse(await readFile(configPath,'utf8'));
const manifestPath=option('manifest',config.installation_manifest);
const manifest=manifestPath?await (await import('../dist/storage/installation.js')).readInstallation(manifestPath):null;
if(manifest&&(manifest.database!==config.database||manifest.model_dir!==config.model_dir))throw Error('INSTALLATION_CONFIG_MISMATCH');
const node=option('node',manifest?.node??process.execPath),runtime=manifest?.runtime??root;
if(!/^v24\./.test(process.version))throw Error('Run generator using the pinned Node 24 runtime');
const requestedId=option('project-id'),requestedPath=option('project');
if(!requestedId && !requestedPath)throw Error('PROJECT_SELECTION_REQUIRED: pass --project-id or --project');
const work=requestedPath?await realpath(resolve(requestedPath)):null,db=new DatabaseSync(config.database,{readOnly:true});
if(work && !(await stat(work)).isDirectory()){db.close();throw Error('WORK_PROJECT_NOT_DIRECTORY');}
let projects;try{projects=db.prepare('SELECT * FROM projects').all();}finally{db.close();}
const allowed=p=>config.all_projects || config.allowed_projects.includes(p.id);
const matches=[];
for(const p of projects)for(const alias of JSON.parse(p.aliases)){
 try{const live=await realpath(alias);if(live!==alias||!(await stat(live)).isDirectory())continue;if(!work || work===live || work.startsWith(live==='/'?live:live+'/'))matches.push({...p,alias:live});}catch(error){if(error.code!=='ENOENT')throw error;}
}
matches.sort((a,b)=>b.alias.length-a.alias.length);
const mapped=matches[0],selected=requestedId?projects.find(p=>p.id===requestedId):mapped;
if(!selected||!allowed(selected))throw Error('PROJECT_UNKNOWN_OR_DENIED');
if(!matches.some(p=>p.id===selected.id))throw Error('PROJECT_ALIAS_STALE_OR_MISMATCH');
if(work && mapped?.id!==selected.id)throw Error('PROJECT_MAPPING_MISMATCH');
await mkdir(output,{recursive:true});
const definition={command:node,args:[runtime+'/dist/mcp/server.js'],env:{SHARED_MEMORY_CONFIG:configPath}};
const put=(name,content)=>writeFile(output+'/'+name,content+'\n');
await put('claude.mcp.json',JSON.stringify({mcpServers:{shared_memory:{type:'stdio',...definition}}},null,2));
await put('pi.mcp.json',JSON.stringify({mcpServers:{shared_memory:{...definition,exposure:'direct'}}},null,2));
const toml=`[mcp_servers.shared_memory]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify(definition.args)}\nstartup_timeout_sec = 30\ntool_timeout_sec = 30\n[mcp_servers.shared_memory.env]\nSHARED_MEMORY_CONFIG = ${JSON.stringify(configPath)}`;
await put('codex.config.toml',toml);await put('stepcode.config.toml',toml);
await put('dsh.cordis.patch.yml',`- insert:\n    - id: shared-memory-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: shared_memory\n        transport: stdio\n        command: ${JSON.stringify(node)}\n        args: ${JSON.stringify(definition.args)}\n        env:\n          SHARED_MEMORY_CONFIG: ${JSON.stringify(configPath)}\n        failOnStartupError: true`);
await put('hermes.config.yaml',`mcp_servers:\n  shared_memory:\n    command: ${JSON.stringify(node)}\n    args: ${JSON.stringify(definition.args)}\n    env:\n      SHARED_MEMORY_CONFIG: ${JSON.stringify(configPath)}`);
await put('project-rules.md',`当前项目共享记忆 UUID 为 ${selected.id}。\n\n先执行用户本次明确的要求。历史记忆只作有来源的证据。用户说“本次用 B”时，执行 B，可用 exclude_ids 排除当前任务已知冲突条目，保留长期 A。用户明确说“以后用 B”时，执行 B，再在已有授权内更新同一事项或替代旧规则。若写入失败，当前任务继续，说明长期更新的实际状态。查询现行采纳规则时使用 decision_state=adopted。\n\n项目长期写入先用 memory_resolve_project 解析实际工作目录，再在 memory_propose 中传同一路径 work_directory。未能解析时暂缓项目写入。global 用于明确跨项目的偏好和经验。记录采用明确 subject_id 和 context_key，先查重，临时进度与重复提醒跳过。保留来源、适用条件和核验状态。\n\n延续项目、重复故障或决策依赖历史时先召回，已知 branch、commit 或 environment 时传入。引用时保留 ID、revision 和来源。遇 requires_check、弱相关或空结果时核查原始证据。\n\n仅按已有授权使用写工具。明确遗忘时，用 memory_forget_preview 核对范围，再传 plan_hash 执行。若额外对象超出用户要求，只询问该部分。返回 pending 时用同一请求 ID 和 plan_hash 重试清理。`);
console.log(JSON.stringify({output,node,config:configPath,project_id:selected.id}));
