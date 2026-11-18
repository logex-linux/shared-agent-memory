import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {z} from 'zod';
import {versionRefSchema} from '../dist/core/contracts.js';

const target=versionRefSchema.extend({
  source_index:z.number().int().min(0).max(11),
  anchor:z.string().trim().min(1).max(500).optional(),
  fragment:z.object({start:z.number().int().nonnegative(),end:z.number().int().positive()}).strict()
    .refine(range=>range.end>range.start,'Use nonempty byte offsets').optional(),
  git_path:z.string().min(1).max(4096).optional(),
  directory_files:z.array(z.string().min(1).max(4096)).max(20).optional()
}).strict();
const manifest=z.object({
  roots:z.array(z.string().refine(isAbsolute,'Use an absolute source root')).min(1).max(64),
  targets:z.array(target).min(1).max(250)
}).strict();
const maxFileBytes=32*1024*1024;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const under=(root,path)=>{
  const rel=relative(root,path);
  return rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel);
};

function location(path) {
  try {
    const file=realpathSync(path),stat=statSync(file);
    return {path:file,state:stat.isFile()?'file':stat.isDirectory()?'directory':'unresolved',size:stat.size};
  } catch(error) {
    return {path,state:['ENOENT','ENOTDIR'].includes(error.code)?'missing':'unresolved'};
  }
}
function localPath(uri) {
  if(isAbsolute(uri))return uri;
  try{return fileURLToPath(uri);}catch{return null;}
}

// Numbered Markdown sections and literal lines give a reproducible locator.
function anchorLine(bytes,locator,anchor) {
  if(!anchor)return null;
  const lines=bytes.toString('utf8').split(/\r?\n/);
  const number=locator.match(/(?:\bsection\s+|§\s*|第\s*)(\d+)/i)?.[1];
  if(number&&anchor.match(/^[ #*_]*(\d+)[.．、)\s]/)?.[1]!==number)return null;
  const hits=lines.flatMap((line,i)=>line.trim()===anchor?[i+1]:[]);
  return hits.length===1?hits[0]:null;
}

function gitBytes(path,commit,expectedPath) {
  const git=(...args)=>execFileSync('git',['--no-replace-objects','-C',dirname(path),...args],{
    env:{...process.env,GIT_NO_LAZY_FETCH:'1',GIT_OPTIONAL_LOCKS:'0'},stdio:['ignore','pipe','ignore'],maxBuffer:maxFileBytes
  });
  try {
    const root=realpathSync(git('rev-parse','--show-toplevel').toString().trim());
    const pathInGit=relative(root,path);
    if(pathInGit!==expectedPath||!under(root,path)||
      git('rev-parse','--verify',commit+'^{commit}').toString().trim()!==commit)return null;
    return git('cat-file','blob',commit+':'+pathInGit);
  } catch {return null;}
}

function checkCandidate(file,source,ref) {
  const result={path:file.path,state:'requires_check'};
  if(file.size>maxFileBytes)return {...result,reason:'file_too_large'};
  let bytes;
  try {bytes=readFileSync(file.path);}catch{return {...result,reason:'file_unreadable'};}
  if(bytes.length>maxFileBytes)return {...result,reason:'file_too_large'};
  const full=source.revision_ref.match(/^sha256(?:-file)?:([a-f0-9]{64})$/)?.[1];
  const fragment=source.revision_ref.match(/^sha256-fragment:([a-f0-9]{64})$/)?.[1];
  const commit=source.revision_ref.match(/^(?:git:)?([a-f0-9]{40})$/)?.[1];
  const fullHash=digest(bytes);
  let basis,expected,actual;
  if(full){
    basis='file_sha256'; expected=full; actual=fullHash;
  }else if(fragment&&ref.fragment&&ref.fragment.end<=bytes.length){
    basis='fragment_sha256'; expected=fragment; actual=digest(bytes.subarray(ref.fragment.start,ref.fragment.end));
  }else if(commit&&ref.git_path){
    basis='git_commit'; expected=commit;
    const blob=gitBytes(file.path,commit,ref.git_path);
    actual=blob?.equals(bytes)?commit:null;
  }else return {...result,reason:'recorded_fingerprint_or_range_missing'};
  const recordedHash=basis==='fragment_sha256'?actual:fullHash;
  const identity={basis,expected,actual,file_sha256:fullHash};
  if(expected!==actual||source.source_hash&&source.source_hash!==recordedHash)
    return {...result,...identity,reason:'fingerprint_changed'};
  const line=anchorLine(bytes,source.locator,ref.anchor);
  if(!line)return {...result,...identity,reason:'locator_unconfirmed'};
  return {...result,...identity,state:'match',line,anchor:ref.anchor};
}

export function previewSources(db,raw) {
  const plan=manifest.parse(raw);
  const roots=[...new Set(plan.roots.map(root=>{
    const found=location(root);
    if(found.state!=='directory')throw Error('SOURCE_ROOT_UNAVAILABLE: '+root);
    return found.path;
  }))];
  const inRoot=file=>roots.some(root=>under(root,file.path));
  db.exec('BEGIN');
  try {
    const generation=db.prepare("SELECT value FROM meta WHERE key='generation'").get().value;
    const exact=db.prepare(`SELECT v.body,m.revision current_revision,m.status FROM memory_version_bodies v
      JOIN memories m ON m.id=v.memory_id WHERE v.memory_id=? AND v.revision=?`);
    const results=plan.targets.map(ref=>{
      const row=exact.get(ref.memory_id,ref.revision),source=row?.body&&JSON.parse(row.body).sources[ref.source_index];
      const {memory_id,revision,source_index}=ref;
      const key={memory_id,revision,source_index};
      if(!source||row.status!=='active')return {...key,state:'revision_or_source_unavailable'};
      const path=localPath(source.uri);
      if(!path)return {...key,source,state:'non_local'};
      const original=location(path);
      const entry={...key,source,original_state:original.state,current_revision:row.current_revision};
      if(original.state==='directory'){
        const files=(ref.directory_files??[]).filter(file=>!isAbsolute(file)&&source.locator.includes(file))
          .map(file=>location(resolve(original.path,file)))
          .filter(file=>file.state==='file'&&under(original.path,file.path)&&inRoot(file)).map(file=>file.path);
        return {...entry,state:files.length?'directory_files_available':'directory_locator_needed',files:[...new Set(files)]};
      }
      // Search only the listed directories, with the original basename.
      const candidates=[original,...roots.map(root=>location(join(root,basename(path))))]
        .filter(file=>file.state==='file'&&inRoot(file));
      const checked=[...new Map(candidates.map(file=>[file.path,file])).values()].map(file=>checkCandidate(file,source,ref));
      const matches=checked.filter(file=>file.state==='match');
      const current=matches.find(file=>file.path===original.path);
      const replacement=original.state==='missing'&&matches.length===1?matches[0]:null;
      const state=current?'source_available':replacement?'replacement_available':matches.length>1?'ambiguous':'requires_check';
      return {...entry,state,candidates:checked,...(replacement&&{replacement,
        safe_to_revise:row.current_revision===revision})};
    });
    return {dry_run:true,generation,roots,results};
  } finally {db.exec('ROLLBACK');}
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const [database,input]=process.argv.slice(2);
  if(!database||!input)throw Error('Usage: source-preview.mjs DATABASE REVIEW_MANIFEST.json');
  const db=new DatabaseSync(resolve(database),{readOnly:true});
  try{console.log(JSON.stringify(previewSources(db,JSON.parse(readFileSync(input,'utf8'))),null,2));}
  finally{db.close();}
}
