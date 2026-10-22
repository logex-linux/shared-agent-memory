import {randomUUID} from 'node:crypto';
import {record} from './helpers.mjs';
import {indexChunk} from '../dist/retrieval/indexes.js';
export const vector=(a=1,b=0)=>{const v=new Float32Array(512);v[0]=a;v[1]=b;return v;};
export const fake={profile:async()=>({id:'adaptive-test',manifest:{test:true}}),query:async()=>vector(),chunks:async(title,text)=>[{start:0,end:text.length,text,tokens:10,vector:vector()}]};
export function seed(s,projects,count,{relevant=true,valid_for={},start=0}={}){
 const ids=[];s.storage.transaction(()=>{
  s.db.prepare('INSERT OR IGNORE INTO embedding_profiles VALUES(?,?)').run('adaptive-test','{}');
  for(let i=0;i<count;i++){
   const project=projects[i%projects.length],id=randomUUID(),r=record(project,{kind:'preference',title:relevant?'设计偏好证据 '+(start+i):'园艺清单 '+i,content:relevant?`设计偏好：简洁排版、易读字体，场景${start+i}。这是独立证据，不是普遍结论。`:'花园种子的库存数量。',tags:[relevant?'设计'+i%5:'园艺'],valid_for});r.sources[0].checked_at=`2025-${String(i%12+1).padStart(2,'0')}-01T00:00:00.000Z`;
   s.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,project,project?'project':'global',JSON.stringify(r),1,'active',r.sources[0].checked_at,r.sources[0].checked_at,'adaptive-test','fixture:'+id,null,'test');
   const c=s.db.prepare('INSERT INTO memory_chunks(memory_id,revision,start,end,tokens,text,profile_id) VALUES(?,1,0,?,10,?,?)').run(id,r.content.length,r.content,'adaptive-test');const v=relevant?vector():vector(0,1);
   s.db.prepare('INSERT INTO memory_vec VALUES(?,?,?)').run(BigInt(c.lastInsertRowid),Buffer.from(v.buffer),project??'global');indexChunk(s.db,{id:Number(c.lastInsertRowid),memory_id:id,text:r.content},r.title,r.tags);s.db.prepare('INSERT INTO memories_fts VALUES(?,?)').run(id,r.title+' '+r.content);ids.push(id);
  }s.storage.advance();
 });return ids;
}
export async function collect(s,input){const pages=[],seen=new Set();let request=input;do{const r=await s.recall(request);pages.push(r);for(const i of r.items){if(seen.has(i.id))throw Error('Duplicate '+i.id);seen.add(i.id);}if(!r.has_more)return {ids:[...seen],pages};if(!r.next_cursor)throw Error('Missing cursor');request={cursor:r.next_cursor,debug:input.debug};}while(true);}
