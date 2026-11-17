import type {DatabaseSync} from 'node:sqlite';
import {applicability,hash,MemoryError,type Config,type MemoryRecord} from '../core/contracts.js';
import type {BrowseInput,ViewScope} from '../core/frontier-contracts.js';
import {eligibility,readScopePredicate} from '../retrieval/recall.js';
import {authority} from '../retrieval/state.js';
import {taskExclusions} from '../retrieval/task-override.js';
import {coversEffectiveTime} from './temporal.js';
import {sourceStatus} from './source-status.js';

type Section='projects'|'subjects'|'preferences'|'current'|'evidence'|'procedures'|'conflicts'|'history'|'pending'|'source-gaps'|'unclassified';
type Route={section:Section;project_id?:string;global?:boolean;subject_id?:string};
const sections=['current','evidence','procedures','conflicts','history'];
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const subject='coalesce(s.subject_id,i.subject_id)',contextKey='coalesce(s.context_key,i.context_key)';

export function catalogRoute(uri:string):Route {
  try {
    const url=new URL(uri);
    const path=url.pathname.split('/').slice(1).filter(Boolean).map(decodeURIComponent);
    if(url.protocol!=='sam:'||url.search||url.hash||url.username||url.password||url.port)throw Error();
    if(url.hostname==='maintenance'&&path.length===1&&['pending','source-gaps','unclassified'].includes(path[0]))
      return {section:path[0] as Section};
    if(url.hostname==='global'&&path.length===1&&path[0]==='preferences')return {section:'preferences',global:true};
    if(url.hostname==='projects'&&!path.length)return {section:'projects'};
    const global=url.hostname==='global';
    if(!global&&(url.hostname!=='projects'||!uuid.test(path[0])))throw Error();
    const project_id=global?undefined:path.shift();
    if(path[0]!=='subjects')throw Error();
    if(path.length===1)return {section:'subjects',project_id,global};
    if(path.length<=3&&path[1].length<=256&&(!path[2]||sections.includes(path[2])))
      return {section:(path[2]??'current') as Section,project_id,global,subject_id:path[1]};
  } catch {}
  throw new MemoryError('CATALOG_URI_INVALID');
}

const projectUri=(id:string)=>`sam://projects/${id}/subjects/`;
const subjectUri=(route:Route,id:string)=>`${route.global?'sam://global/subjects/':projectUri(route.project_id!)}${encodeURIComponent(id)}/`;
const json=<T>(value:unknown,fallback:T):T=>typeof value==='string'?JSON.parse(value):fallback;
type Meta=Omit<MemoryRecord,'content'>;
type EntryRow={memory_id:string;revision:number;project_id:string|null;scope:string;metadata:string;head:number;
  recorded_at:string;subject_id:string|null;context_key:string|null;start:number|null;end:number|null;body_state:string};

export function browseCatalog(db:DatabaseSync,config:Config,generation:number,input:BrowseInput,route:Route) {
  const {section,project_id,global,subject_id}=route;
  const scope={...input,...(project_id&&{project_id,include_global:false}),...(global&&{project_id:undefined,include_global:true})};
  const task=taskExclusions(db,config,generation,scope.task_id);
  const {cursor,...filters}=input;
  const stamp=hash({filters,authority:authority(config,db),generation,task:task?.binding});
  let as_of=input.as_of??new Date().toISOString(),offset=0;
  if(cursor){
    try {
      const token=JSON.parse(Buffer.from(cursor,'base64url').toString()) as {as_of:string;offset:number;stamp:string};
      if(!Number.isFinite(Date.parse(token.as_of))||!Number.isSafeInteger(token.offset)||token.offset<0||
        token.stamp!==hash([stamp,token.as_of,token.offset]))throw Error();
      ({as_of,offset}=token);
    } catch {throw new MemoryError('CATALOG_CURSOR_STALE');}
  }
  const next=(position:number)=>Buffer.from(JSON.stringify({as_of,offset:position,stamp:hash([stamp,as_of,position])})).toString('base64url');
  const request={...scope,context_key:undefined,exact_only:false,debug:false};
  const base=readScopePredicate(request,config,task?.ids),live=eligibility(db,request,config,as_of,task?.ids);
  const scopeCondition=global?" AND s.scope='global'":'';
  const current=`FROM memory_search s JOIN memories m ON m.id=s.memory_id
    LEFT JOIN claim_projection i ON i.memory_id=s.memory_id AND i.revision=s.revision WHERE ${live.sql}${scopeCondition}`;
  const countPage=(count:number,items:unknown[],position=offset+items.length,nextPage=position<count)=>{
    const result={uri:input.uri,section,generation,as_of,count,items,next_cursor:nextPage?next(position):null};
    while(items.length>1&&Buffer.byteLength(JSON.stringify(result))>Math.min(config.page_response_bytes,config.response_token_budget*3)){
      items.pop();
      result.next_cursor=next(--position);
    }
    if(Buffer.byteLength(JSON.stringify(result))>Math.min(config.page_response_bytes,config.response_token_budget*3))
      throw new MemoryError('PAGE_BUDGET_TOO_SMALL');
    return result;
  };
  if(section==='projects'){
    const args=[...live.params,Number(config.all_projects),JSON.stringify(input.project_id?[input.project_id]:config.allowed_projects),input.project_id??null,input.project_id??null];
    const query=`FROM projects p LEFT JOIN memory_search s ON s.project_id=p.id AND ${live.sql}
      WHERE (?=1 OR p.id IN (SELECT value FROM json_each(?))) AND (? IS NULL OR p.id=?)`;
    const count=Number(db.prepare('SELECT count(DISTINCT p.id) n '+query).get(...args)?.n);
    const items=db.prepare(`SELECT p.id project_id,p.name title,count(s.memory_id) records ${query}
      GROUP BY p.id,p.name ORDER BY p.name,p.id LIMIT ? OFFSET ?`).all(...args,input.limit,offset)
      .map(r=>({...r,uri:projectUri(String(r.project_id))}));
    return countPage(count,items);
  }
  if(section==='pending'){
    if(task||input.exclude_ids?.length)return countPage(0,[]);
    // Project visibility is the same as for committed records. A queue entry
    // exposes only its owner, state and lease within that connection.
    const query=`FROM proposals s WHERE ${base.sql.replace("s.status='active'","s.status='pending'")}
      AND (s.connection_id=? OR ?=1) AND julianday(s.expires_at)>julianday(?)`;
    const params=[...base.params,config.connection_id,Number(config.operations.includes('manage')),as_of];
    const items=db.prepare(`SELECT s.id proposal_id,s.project_id,s.scope,s.created_at,s.expires_at ${query}
      ORDER BY s.created_at DESC,s.id LIMIT ? OFFSET ?`).all(...params,input.limit,offset);
    return countPage(Number(db.prepare('SELECT count(*) n '+query).get(...params)?.n),items);
  }
  const conditions=input.context_key?` AND ${contextKey}=?`:'';
  const args=[...live.params,...(input.context_key?[input.context_key]:[])];
  if(section==='subjects'){
    const group=`${current}${conditions} AND ${subject} IS NOT NULL GROUP BY ${subject},${contextKey}`;
    const count=Number(db.prepare(`SELECT count(*) n FROM (SELECT 1 ${group})`).get(...args)?.n);
    const rows=db.prepare(`SELECT ${subject} subject_id,${contextKey} context_key,count(*) records,max(m.verified_at) updated_at
      ${group} ORDER BY subject_id,context_key LIMIT ? OFFSET ?`).all(...args,input.limit,offset);
    return countPage(count,rows.map(r=>({...r,title:r.subject_id,uri:subjectUri(route,String(r.subject_id))})));
  }
  const canonical=subject_id?db.prepare(`SELECT DISTINCT ${subject} subject_id,${contextKey} context_key ${current}${conditions}
    AND i.aliases IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(i.aliases) WHERE value=?)`).all(...args,subject_id):[];
  const from=`SELECT s.memory_id,s.revision,s.project_id,s.scope,s.metadata,s.revision head,
    m.verified_at recorded_at,${subject} subject_id,${contextKey} context_key,i.start,i.end,'retained' body_state ${current}${conditions}`;
  const identity=subject_id?` AND (${subject}=? OR EXISTS(SELECT 1 FROM json_each(?) q
    WHERE json_extract(q.value,'$.subject_id')=${subject} AND json_extract(q.value,'$.context_key') IS ${contextKey}))`:'';
  const filtered=[...args,...(subject_id?[subject_id,JSON.stringify(canonical)]:[])];
  const applicable=(row:EntryRow,meta:Meta)=>applicability(meta.valid_for??{},input.context)==='current'&&
    (!input.as_of || Boolean(meta.valid_time?.valid_from&&meta.valid_time?.valid_to)) &&
    (!['preference','decision'].includes(meta.kind)||meta.decision_state==='adopted') &&
    meta.verification?.status!=='disputed' &&
    (section!=='history'||row.head===row.revision&&(meta.lifecycle??'current')==='current');
  const describe=(row:EntryRow,span=false)=>{
    const ref={memory_id:row.memory_id,revision:row.revision};
    if(row.body_state==='pruned')return {...ref,body_state:'pruned',recorded_at:row.recorded_at,applicability:'requires_check'};
    const meta=json(row.metadata,{} as Meta);
    const conditions={valid_for:meta.valid_for,valid_time:meta.valid_time};
    const location=span?db.prepare('SELECT body FROM memory_version_bodies WHERE memory_id=? AND revision=?')
      .get(row.memory_id,row.revision):undefined;
    const content=location?json(location.body,{} as MemoryRecord).content:undefined;
    const start=row.start??0,end=Math.min(row.end??4000,content?.length??0,start+300);
    const endOfSpan=content&&end<content.length&&/[\uDC00-\uDFFF]/.test(content[end])?end-1:end;
    const all=meta.sources??[];
    return {...ref,title:meta.title,kind:meta.kind,scope:row.scope,project_id:row.project_id,
      subject_id:row.subject_id,context_key:row.context_key,recorded_at:row.recorded_at,lifecycle:meta.lifecycle??'current',
      decision_state:meta.decision_state??'unknown',applicability:applicable(row,meta)?'current':'requires_check',...conditions,
      sources:all.slice(0,2).map(sourceStatus),additional_sources:Math.max(0,all.length-2),
      ...(content&&endOfSpan>start&&{span:{start,end:endOfSpan,text:content.slice(start,endOfSpan)}})};
  };
  if(section==='history'){
    const keys=JSON.stringify(canonical);
    const versions=`WITH scoped AS (
      SELECT v.memory_id,v.revision,s.project_id,s.scope,coalesce(v.body,v.pruned_context) metadata,s.revision head,
        v.recorded_at,v.body_state,i.start,i.end,
        coalesce(json_extract(coalesce(v.body,v.pruned_context),'$.subject_id'),i.subject_id) subject_id,
        coalesce(json_extract(coalesce(v.body,v.pruned_context),'$.context_key'),i.context_key) context_key
      FROM memory_version_bodies v JOIN memory_search s ON s.memory_id=v.memory_id
        LEFT JOIN claim_projection i ON i.memory_id=v.memory_id AND i.revision=v.revision WHERE ${base.sql}${scopeCondition}
    ) SELECT * FROM scoped t WHERE (t.subject_id=? OR EXISTS(SELECT 1 FROM json_each(?) q
      WHERE json_extract(q.value,'$.subject_id')=t.subject_id AND json_extract(q.value,'$.context_key') IS t.context_key))
      ${input.context_key?'AND t.context_key=?':''}`;
    const params=[...base.params,subject_id!,keys,...(input.context_key?[input.context_key]:[])];
    const applicableContext=(['branch','commit','environment'] as const).filter(key=>input.context[key]);
    const qualifiers=applicableContext.map(key=>` AND (json_extract(t.metadata,'$.valid_for.${key}') IS NULL
      OR json_extract(t.metadata,'$.valid_for.${key}')=?)`).join('');
    params.push(...applicableContext.map(key=>input.context[key]!));
    const time=input.as_of?`
      AND (json_extract(t.metadata,'$.valid_time.valid_from') IS NULL OR julianday(json_extract(t.metadata,'$.valid_time.valid_from'))<=julianday(?))
      AND (json_extract(t.metadata,'$.valid_time.valid_to') IS NULL OR julianday(json_extract(t.metadata,'$.valid_time.valid_to'))>julianday(?))`:'';
    if(input.as_of)params.push(as_of,as_of);
    const list=versions+qualifiers+time,count=Number(db.prepare('SELECT count(*) n FROM ('+list+')').get(...params)?.n);
    const rows=db.prepare(list+' ORDER BY recorded_at DESC,memory_id,revision DESC LIMIT ? OFFSET ?')
      .all(...params,input.limit,offset) as EntryRow[];
    return countPage(count,rows.map(row=>describe(row)));
  }
  if(section==='conflicts'){
    const listed=`${from}${identity}`;
    const links=db.prepare(`WITH active AS MATERIALIZED (${from}), chosen AS MATERIALIZED (${listed})
      SELECT e.id relation_id,e.from_id,e.from_revision,e.to_id,e.to_revision FROM memory_relations e
      JOIN active a ON a.memory_id=e.from_id AND a.revision=e.from_revision
      JOIN active b ON b.memory_id=e.to_id AND b.revision=e.to_revision
      WHERE e.type='contradicts' AND (a.memory_id IN (SELECT memory_id FROM chosen) OR b.memory_id IN (SELECT memory_id FROM chosen))
      ORDER BY e.id`).all(...args,...filtered);
    const disputes=db.prepare(listed+` AND json_extract(s.metadata,'$.verification.status')='disputed' ORDER BY s.memory_id`).all(...filtered);
    const items=[...links.map(r=>({state:'recorded_conflict',from:{memory_id:r.from_id,revision:r.from_revision},
      to:{memory_id:r.to_id,revision:r.to_revision},relation_id:r.relation_id})),
      ...disputes.map(r=>({state:'disputed_claim',...describe(r as EntryRow)}))];
    return countPage(items.length,items.slice(offset,offset+input.limit));
  }
  if(section==='source-gaps'){
    const batch=250,rows=db.prepare(from+' ORDER BY s.memory_id LIMIT ? OFFSET ?').all(...args,batch+1,offset) as EntryRow[];
    const items=[];
    let scanned=0,unchecked=0;
    for(const row of rows.slice(0,batch)){
      scanned++;
      const states=json(row.metadata,{} as Meta).sources?.map(sourceStatus)??[];
      unchecked+=states.filter(r=>r.state==='unchecked').length;
      const gaps=states.filter(r=>r.state==='missing'||r.state==='unresolved');
      if(gaps.length)items.push({...describe(row),sources:gaps.slice(0,2),additional_sources:Math.max(0,gaps.length-2)});
      if(items.length>=input.limit)break;
      if(items.length>1&&Buffer.byteLength(JSON.stringify(items))>Math.min(config.page_response_bytes,config.response_token_budget*3)-512){
        items.pop();scanned--;break;
      }
    }
    return {...countPage(items.length,items,offset+scanned,rows.length>scanned),scanned,unchecked_sources:unchecked};
  }
  const clause=section==='unclassified'?` AND (${subject} IS NULL OR ${contextKey} IS NULL)`
    :section==='preferences'?" AND s.kind='preference'"
    :section==='procedures'?" AND (s.kind='procedure' OR json_extract(s.metadata,'$.memory_form')='procedural')":'';
  const adopted=section==='current'
    ? " AND (s.kind NOT IN ('preference','decision') OR s.decision_state='adopted') AND coalesce(json_extract(s.metadata,'$.verification.status'),'')<>'disputed'":'';
  const list=from+identity+clause+adopted;
  const count=Number(db.prepare('SELECT count(*) n FROM ('+list+')').get(...filtered)?.n);
  const rows=db.prepare(list+' ORDER BY m.verified_at DESC,s.memory_id LIMIT ? OFFSET ?').all(...filtered,input.limit,offset) as EntryRow[];
  return countPage(count,rows.map(row=>describe(row,['current','evidence','procedures'].includes(section))));
}

export function explainVisibility(db:DatabaseSync,config:Config,generation:number,input:ViewScope&{memory_id:string;revision?:number}) {
  const visible=readScopePredicate({project_id:input.project_id,include_global:input.include_global},config);
  const head=db.prepare(`SELECT s.metadata,s.revision,s.lifecycle FROM memory_search s WHERE ${visible.sql} AND s.memory_id=?`)
    .get(...visible.params,input.memory_id);
  if(!head)return {state:'not_visible'};
  const task=taskExclusions(db,config,generation,input.task_id);
  if(input.exclude_ids?.includes(input.memory_id)||task?.ids.includes(input.memory_id))return {state:'excluded',reason:'task_override'};
  const version=input.revision?db.prepare('SELECT body,pruned_context,body_state FROM memory_version_bodies WHERE memory_id=? AND revision=?')
    .get(input.memory_id,input.revision):undefined;
  if(input.revision&&!version)return {state:'not_visible'};
  const body=json(version?.body??version?.pruned_context??head.metadata,{} as Meta);
  const valid=body.valid_for??{};
  const {expires_at,...condition}=valid,at=input.as_of??new Date().toISOString();
  const check=applicability(condition,input.context);
  if(check==='excluded')return {state:'excluded',reason:'context_mismatch'};
  if(!coversEffectiveTime(body.valid_time,at)&&(input.as_of||!version))return {state:'excluded',reason:'outside_effective_time'};
  if(version?.body_state==='pruned')return {state:'excluded',reason:'revision_pruned'};
  if(!version&&expires_at&&Date.parse(expires_at)<=Date.now())return {state:'excluded',reason:'expired'};
  const lifecycle=body.lifecycle??'current';
  if(!version&&lifecycle!=='current'&&!(input.as_of&&lifecycle==='historical'))return {state:'excluded',reason:lifecycle};
  const history=Boolean(version&&input.revision!==head.revision||lifecycle!=='current');
  const unadopted=['decision','preference'].includes(body.kind)&&body.decision_state!=='adopted';
  const missingTime=Boolean(input.as_of&&(!body.valid_time?.valid_from||!body.valid_time?.valid_to));
  const reason=history?'historical_evidence':body.verification?.status==='disputed'?'disputed':
    unadopted?'adoption_unconfirmed':missingTime?'effective_time_unknown':check==='requires_check'?'context_required':'applicable';
  return {state:reason==='applicable'?'visible':'requires_check',reason,
    memory_id:input.memory_id,revision:input.revision??head.revision,valid_for:valid,valid_time:body.valid_time,
    sources:body.sources?.slice(0,3).map(sourceStatus)};
}
