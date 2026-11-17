import {readFile,readdir,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {hash,planHashSchema} from '../core/contracts.js';

const absolute=z.string().startsWith('/');
const installationSchema=z.object({
  format:z.literal('shared-agent-memory/installation-v1'),
  source:absolute,runtime:absolute,data:absolute,database:absolute,model_dir:absolute,maintenance_state:absolute,
  node:absolute,version:z.string().min(1),schema:z.number().int().positive(),
  commit:z.string().regex(/^[0-9a-f]{40}$/).nullable(),model_profile:planHashSchema,
  artifacts_sha256:planHashSchema
}).strict();

export async function readInstallation(path:string) {
  return installationSchema.parse(JSON.parse(await readFile(path,'utf8')));
}

export async function artifactHash(root:string) {
  const paths=(await readdir(join(root,'dist'),{recursive:true,withFileTypes:true})).filter(entry=>entry.isFile())
    .map(entry=>join(entry.parentPath,entry.name).slice(root.length+1));
  const bytes=await Promise.all([...paths,'package.json','package-lock.json'].sort().map(async name=>[name,hash(await readFile(join(root,name)))]));
  return hash(bytes);
}

export async function makeInstallation(input:Omit<z.infer<typeof installationSchema>,'format'|'artifacts_sha256'>) {
  const runtime=await realpath(input.runtime);
  return installationSchema.parse({...input,runtime,format:'shared-agent-memory/installation-v1',artifacts_sha256:await artifactHash(runtime)});
}
