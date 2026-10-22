import {readFile} from 'node:fs/promises';
import {MemoryService} from '../dist/core/service.js';
import {fake,collect,seed} from './adaptive-helpers.mjs';
const [path,operation,arg]=process.argv.slice(2),config=JSON.parse(await readFile(path)),s=new MemoryService(config,fake);
try{
 const request=arg?JSON.parse(arg):{};
 if(operation==='page')console.log(JSON.stringify(await s.recall(request)));
 else if(operation==='collect')console.log(JSON.stringify(await collect(s,request)));
 else if(operation==='write'){seed(s,[config.allowed_projects[0]],1);console.log(JSON.stringify({generation:s.storage.generation()}));}
 else if(operation==='crash'){
  // Simulates interruption after inserting provisional cache rows, before commit.
  const prepare=s.db.prepare.bind(s.db);s.db.prepare=function(sql){const st=prepare(sql);if(sql.includes('SELECT s.revision,s.project_id')){st.get=()=>process.kill(process.pid,'SIGKILL');}return st;};await s.recall(request);
 }
}catch(e){console.log(JSON.stringify({error:e.code??e.message}));process.exitCode=1;}finally{s.close();}
