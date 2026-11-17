import {statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {MemoryRecord} from '../core/contracts.js';

type Source=MemoryRecord['sources'][number];
export function sourceFamily(source:Source) {
  return source.source_hash?`sha256:${source.source_hash}`:source.uri;
}

export function sourceStatus(source:Source) {
  try {
    const path=source.uri.startsWith('file:')?fileURLToPath(source.uri):source.uri.startsWith('/')?source.uri:null;
    if(!path)return {source,state:'unchecked' as const};
    return {source,state:statSync(path).isFile()?'present' as const:'unresolved' as const};
  } catch(error) {
    const code=(error as NodeJS.ErrnoException).code;
    return {source,state:code==='ENOENT'||code==='ENOTDIR'?'missing' as const:'unresolved' as const};
  }
}
