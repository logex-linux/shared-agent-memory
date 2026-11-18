import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,rename,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {previewSources} from '../scripts/source-preview.mjs';
import {setupFake} from './adaptive-helpers.mjs';
import {publish,record} from './helpers.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const ref=(row,more={})=>({memory_id:row.memory_id,revision:row.revision,source_index:0,...more});

test('offline source preview binds exact revisions to file bytes and numbered headings',async()=>{
  const {service:s,config,root,project}=await setupFake();
  const dir=join(root,'sources'),original=join(root,'plan.md'),destination=join(dir,'plan.md');
  const bytes=Buffer.from('**3．Architecture**\nPrior evidence.\n**4．Permissions**\n');
  await mkdir(dir);
  await writeFile(original,bytes);
  const base=record(project),source={...base.sources[0],uri:original,locator:'section 3; architecture',
    revision_ref:'sha256:'+digest(bytes),source_hash:digest(bytes)};
  const a=await publish(s,{...base,sources:[source]});
  const db=new DatabaseSync(config.database,{readOnly:true});
  try {
    const lookup=(target,roots=[dir])=>previewSources(db,{roots,targets:[target]}).results[0];
    const target=ref(a,{anchor:'**3．Architecture**'});
    await rename(original,destination);
    const preview=lookup(target);
    assert.equal(preview.original_state,'missing');
    assert.equal(preview.state,'replacement_available');
    assert.equal(preview.replacement.line,1);
    assert.equal(preview.safe_to_revise,true);
    assert.equal(lookup({...target,anchor:'**4．Permissions**'}).candidates[0].reason,'locator_unconfirmed');
    await writeFile(destination,Buffer.concat([bytes,Buffer.from('Changed bytes.')]));
    assert.equal(lookup(target).candidates[0].reason,'fingerprint_changed');
    await writeFile(destination,bytes);
    const path=join(root,'another');
    await mkdir(path);
    await writeFile(join(path,'plan.md'),bytes);
    assert.equal(lookup(target,[dir,path]).state,'ambiguous');
    const viewed=await s.inspectMemory({memory_id:a.memory_id,revision:1});
    assert.deepEqual(viewed.items[0].sources,[source]);
    assert.equal(viewed.items[0].revision,1);
  }finally{db.close();s.close();}
});

test('source preview verifies byte ranges, Git blobs and in-root files named by a directory locator',async()=>{
  const {service:s,config,root,project}=await setupFake();
  const dir=join(root,'evidence'),name='notes.md',file=join(dir,name);
  const anchor='# Flight schedule',bytes=Buffer.from(anchor+'\n🚀 Payload\n'),start=bytes.indexOf('🚀');
  await mkdir(dir);
  await writeFile(file,bytes);
  const git=(...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','--quiet');
  git('add',name);
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','Fixture');
  const base=record(project),source={...base.sources[0],uri:join(root,name),locator:'Flight schedule'};
  const hash=digest(bytes.subarray(start));
  const a=await publish(s,{...base,sources:[{...source,revision_ref:'sha256-fragment:'+hash,source_hash:hash}]});
  const b=await publish(s,{...base,sources:[{...source,revision_ref:git('rev-parse','HEAD')}]});
  const outside=join(root,'outside.md');
  await writeFile(outside,'Outside source root');
  await symlink(outside,join(dir,'escape.md'));
  const c=await publish(s,{...base,sources:[{...source,uri:dir,locator:'notes.md and escape.md'}]});
  const db=new DatabaseSync(config.database,{readOnly:true});
  try {
    const plan={roots:[dir],targets:[ref(a,{anchor,fragment:{start,end:bytes.length}}),
      ref(b,{anchor,git_path:name}),ref(c,{directory_files:[name,'escape.md','../outside.md']})]};
    const checked=previewSources(db,plan).results;
    assert.deepEqual(checked.slice(0,2).map(row=>row.replacement.basis),['fragment_sha256','git_commit']);
    assert.deepEqual(checked[2].files,[file]);
    assert.equal(checked[2].state,'directory_files_available');
    assert.equal(previewSources(db,{...plan,targets:[ref(c)]}).results[0].state,'directory_locator_needed');
    await writeFile(file,Buffer.concat([Buffer.from('Changed header\n'),bytes]));
    const changed=previewSources(db,plan).results;
    assert.deepEqual(changed.slice(0,2).map(row=>row.candidates[0].reason),['fingerprint_changed','fingerprint_changed']);
  }finally{db.close();s.close();}
});
