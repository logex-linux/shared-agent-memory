// Explicit one-time setup. Existing config/data is never overwritten.
import {mkdir,cp,access} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf('--'+name);return i<0?fallback:args[i+1];};
if(!/^v24\./.test(process.version))throw Error('Use Node 24.18.0');
const code=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(option('root',join(homedir(),'.local/share/shared-agent-memory'))),project=resolve(option('project',code)),source=resolve(option('model',join(code,'.local/models/bge-small-zh-v1.5')));
try{await access(join(root,'config.json'));throw Error('Configuration exists; use maintenance instructions instead');}catch(error){if(error.code!=='ENOENT')throw error;}
const {BgeEncoder}=await import('../dist/embedding/bge.js');await new BgeEncoder({model_dir:source,dtype:'fp32',threads:2}).profile();
await mkdir(root,{recursive:true,mode:0o700});await cp(source,join(root,'models/bge-small-zh-v1.5'),{recursive:true,errorOnExist:true,force:false});
const identity=option('project-id');
const init=spawnSync(process.execPath,[join(code,'dist/cli/main.js'),'init','--root',root,'--model',join(root,'models/bge-small-zh-v1.5'),'--project',project,'--name','shared-agent-memory',...(identity?['--project-id',identity]:[])],{encoding:'utf8'});
if(init.status!==0)throw Error(init.stderr);
const output=join(root,'client-configs'),generated=spawnSync(process.execPath,[join(code,'scripts/client-configs.mjs'),'--config',join(root,'config.json'),'--output',output],{encoding:'utf8'});
if(generated.status!==0)throw Error(generated.stderr);
console.log(JSON.stringify({installed:JSON.parse(init.stdout),templates:output,note:'No client settings or native memories were modified. Merge the generated project entries when ready.'},null,2));
