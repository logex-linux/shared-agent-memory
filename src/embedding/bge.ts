import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env, pipeline } from '@huggingface/transformers';
import { hash, MemoryError, type Chunk, type Config, type Encoder } from '../core/contracts.js';

export const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = false;

export class BgeEncoder implements Encoder {
  private ready?: Promise<any>;
  private profileReady?: Promise<{id:string;manifest:unknown}>;
  constructor(private config: Pick<Config,'model_dir'|'dtype'|'threads'>) {}
  profile() {
    return this.profileReady ??= (async () => {
      const manifest = JSON.parse(await readFile(join(this.config.model_dir,'manifest.json'),'utf8'));
      for (const [name, expected] of Object.entries(manifest.files)) {
        if (!/^(config\.json|tokenizer\.json|tokenizer_config\.json|special_tokens_map\.json|onnx\/model(_quantized)?\.onnx)$/.test(name)) throw new MemoryError('MODEL_MANIFEST_INVALID');
        const digest=createHash('sha256');
        for await(const chunk of createReadStream(join(this.config.model_dir,name)))digest.update(chunk);
        if (digest.digest('hex') !== expected) throw new MemoryError('MODEL_HASH_MISMATCH',name);
      }
      const required = ['config.json','tokenizer.json','tokenizer_config.json','onnx/'+(this.config.dtype === 'fp32'?'model.onnx':'model_quantized.onnx')];
      if (required.some(x=>!manifest.files[x])) throw new MemoryError('MODEL_MANIFEST_INVALID');
      const protocol = { ...manifest, dtype:this.config.dtype, pooling:'cls', normalize:true, dimensions:512, prefix:QUERY_PREFIX, chunking:'char-offset-token-budget-v1:384:32' };
      return {id:hash(protocol),manifest:protocol};
    })();
  }
  private async load() {
    if (!this.ready) {
      this.ready = (async () => {
        await this.profile();
        return pipeline('feature-extraction',this.config.model_dir,{
          dtype:this.config.dtype, device:'cpu', local_files_only:true,
          session_options:{intraOpNumThreads:this.config.threads, interOpNumThreads:1}
        });
      })();
      this.ready.catch(()=>{ this.ready=undefined; this.profileReady=undefined; });
    }
    return this.ready;
  }
  private async count(text:string) {
    const extractor=await this.load();
    return (await extractor.tokenizer(text,{truncation:false})).input_ids.data.length;
  }
  async encode(text:string): Promise<Float32Array> {
    const extractor = await this.load();
    if (await this.count(text)>512) throw new MemoryError('QUERY_TOO_LONG','Encoded input exceeds 512 tokens');
    const output = await extractor(text,{pooling:'cls',normalize:true,truncation:false});
    const vector=Float32Array.from(output.data as Iterable<number>);
    const norm=Math.hypot(...vector);
    if (vector.length!==512 || !Number.isFinite(norm) || Math.abs(norm-1)>1e-4) throw new MemoryError('EMBEDDING_INVALID');
    return vector;
  }
  query(text:string) { return this.encode(QUERY_PREFIX+text); }
  async chunks(title:string, content:string) {
    const prefix=title+'\n';
    const chunks:Chunk[]=[];
    let start=0;
    while(start<content.length) {
      let low=start+1, high=content.length, end=start;
      while(low<=high) {
        const mid=Math.floor((low+high)/2);
        if (await this.count(prefix+content.slice(start,mid))<=384) {end=mid;low=mid+1;} else high=mid-1;
      }
      if (end===start) throw new MemoryError('CONTENT_TOKEN_BUDGET');
      const text=content.slice(start,end), tokens=await this.count(prefix+text);
      chunks.push({text,start,end,tokens,vector:await this.encode(prefix+text)});
      if (end===content.length) break;
      let overlapStart=end;
      while(overlapStart>start+1 && await this.count(content.slice(overlapStart-1,end))<=32) overlapStart--;
      start=overlapStart;
    }
    return chunks;
  }
}
