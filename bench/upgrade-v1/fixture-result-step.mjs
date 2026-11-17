import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import sharedMemory from '../../adapters/pi-stdio.mjs';

export const description='Execute the synthetic task by writing its exact result value once to the isolated fixture output file.';
export async function save({value}) {
  if(!/\/shared-agent-memory-runs\/lifecycle-agents-[^/]+\/[^/]+\/project$/.test(process.cwd()))
    throw Error('FIXTURE_WORKSPACE_REQUIRED');
  if(typeof value!=='string'||!/^[A-Za-z0-9_\-|]{1,90}$/.test(value))
    throw Error('FIXTURE_RESULT_INVALID');
  await writeFile(resolve('fixture-result.txt'),value,{mode:0o600,flag:'wx'});
  return {content:[{type:'text',text:'Fixture result written.'}]};
}

export default function fixture(pi) {
  sharedMemory(pi);
  pi.registerTool({name:'write_fixture_result',label:'Write fixture result',description,
    parameters:{type:'object',properties:{value:{type:'string'}},required:['value']},
    execute:(_id,input)=>save(input)});
}
