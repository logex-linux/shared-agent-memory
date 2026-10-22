import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { MemoryService } from '../dist/core/service.js';
import { record } from './helpers.mjs';
const [configFile,operation,arg]=process.argv.slice(2);
const config=JSON.parse(await readFile(configFile,'utf8'));
const service=new MemoryService(config,undefined,point=>{if(operation==='crash'&&point===arg)process.kill(process.pid,'SIGKILL');});
try {
  if(operation==='write') {
    const results=[];
    for(let i=0;i<100;i++) {
      const propose={request_id:randomUUID(),record:record(config.allowed_projects[0],{title:`并发 ${arg}-${i}`,content:`并发写入 ${arg}-${i} 的唯一测试事实，必须真实生成向量并完成原子提交。`})};
      const p=await service.propose(propose);await service.propose(propose);
      const commit={request_id:randomUUID(),proposal_id:p.proposal_id,expected_revision:0};
      const r=await service.commit(commit);const retry=await service.commit(commit);
      if(retry.memory_id!==r.memory_id)throw new Error('non-idempotent');results.push(r.memory_id);
    }
    console.log(JSON.stringify({ids:results,rss:process.memoryUsage().rss}));
  } else {
    const request=JSON.parse(await readFile(arg.endsWith('.json')?arg:configFile+'.request','utf8'));
    console.log(JSON.stringify(await service.commit(request)));
  }
}catch(error){console.log(JSON.stringify({error:error.code??error.message}));process.exitCode=1;}
finally{service.close();}
