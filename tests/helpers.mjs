import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryService } from '../dist/core/service.js';
export const MODEL=resolve('.local/models/bge-small-zh-v1.5');
export async function setup(options={}) {
  const root=await mkdtemp(join(tmpdir(),'shared-memory-test-'));
  const project=randomUUID(),other=randomUUID();
  const config={database:join(root,'memory.db'),model_dir:MODEL,allowed_projects:[project,other],allow_global:true,operations:['recall','propose','commit','forget','manage'],semantic_threshold:0.65,dtype:'fp32',threads:2,...options};
  const service=new MemoryService(config);
  await service.project(project,'project',root);
  await mkdir(join(root,'other'));await service.project(other,'project',join(root,'other'));
  return {root,project,other,config,service};
}
export function record(project,overrides={}) {
  return {project_id:project,scope:project?'project':'global',kind:'procedure',title:'签名授权排错',content:'应用重新构建后屏幕录制授权失效，稳定代码签名后再重新授予屏幕录制权限。错误码 -67050。',tags:['TCC','codesign'],sources:[{source_type:'test',uri:'test://fixtures/signing',locator:'case 1',revision_ref:'fixture-v1',checked_at:new Date().toISOString()}],verification:{method:'isolated integration test',summary:'Synthetic fixture; not a user preference.'},valid_for:{},author_client:'test',author_session:'integration',derived_from:[],...overrides};
}
export async function publish(service,record,update={}) {
  const p=await service.propose({request_id:randomUUID(),record,...update});
  return service.commit({request_id:randomUUID(),proposal_id:p.proposal_id,expected_revision:p.expected_revision});
}
