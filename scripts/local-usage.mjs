import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {readInstallation} from '../dist/storage/installation.js';

const [manifest,report]=process.argv.slice(2);
if(!manifest)throw Error('Usage: local-usage.mjs INSTALLATION_MANIFEST [UPGRADE_REPORT]');
const {version,schema,source,runtime,node,data}=await readInstallation(manifest);
const configured=name=>existsSync(join(data,name));
const reader=configured('codex.read-only.config.json')?'codex.read-only.config.json':'config.json';
const writers=['codex.writer.config.json','stepcode.writer.config.json'].filter(configured);
const writerNames=(writers.length?writers:['project.config.json']).map(name=>'\x60'+name+'\x60').join('、');
console.log(`# 本机 Shared Agent Memory ${version}

当前数据库为 Schema ${schema}。[安装清单](<${manifest}>)

${report?`[升级报告](<${report}>)\n\n`:''}写入角色配置为 ${writerNames}。只读连接使用 \`${reader}\`。角色由 \`SHARED_MEMORY_CONFIG\` 决定。新建项目记忆时传入已登记的工作目录。

\`\`\`sh
"${node}" "${join(runtime,'dist/cli/main.js')}" recall --config "${join(data,reader)}" --input /absolute/path/query.json
\`\`\`

证据包通过连接的 \`context_pack_enabled\` 单独启用。参见 [事项目录与证据包](<${join(source,'docs/upgrade-v1/frontier-contract.md')}>) 与 [本地维护和恢复](<${join(source,'docs/upgrade-v1/lifecycle.md')}>)。`);
