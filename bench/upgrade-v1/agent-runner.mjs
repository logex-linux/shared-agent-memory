import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const evaluator=fileURLToPath(new URL('./fixture-result.mjs',import.meta.url));
const extension=fileURLToPath(new URL('./fixture-result-step.mjs',import.meta.url));
const parse=line=>{try{return JSON.parse(line);}catch{return null;}};
const decode=result=>result?.structuredContent??result?.structured_content??
  parse(result?.content?.find(block=>block.type==='text')?.text);
const memoryName=name=>name?.replace(/^mcp__shared_memory__/,'');
const numeric=value=>Number.isFinite(value)&&value>=0?value:null;

export function runAgent({client,model,provider,work,config,server,prompt,tools=[],afterRecall,paired=false,timeoutMs=150_000}) {
  const env={...process.env,SHARED_MEMORY_NODE:process.execPath,SAM_AGENT_EVIDENCE_SERVER:server};
  if(config)env.SHARED_MEMORY_CONFIG=config;
  else delete env.SHARED_MEMORY_CONFIG;
  const cli=client==='codex'?process.env.SAM_CODEX_BIN??'codex':
    process.env.SAM_STEP_BIN??join(homedir(),'.stepcode/bin/step');
  const args=client==='codex'?[
    'exec','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--ephemeral','--sandbox','read-only','--json',
    ...(paired?['--disable','shell_tool','--disable','unified_exec','-c','web_search="disabled"',
      '-c','model_reasoning_effort="low"']:[]),
    ...(model?['--model',model]:[]),
    ...(config?[
      '-c','mcp_servers.shared_memory.command='+JSON.stringify(process.execPath),
      '-c','mcp_servers.shared_memory.args='+JSON.stringify([server]),
      '-c','mcp_servers.shared_memory.env.SHARED_MEMORY_CONFIG='+JSON.stringify(config),
      '-c','mcp_servers.shared_memory.enabled_tools='+JSON.stringify(tools)
    ]:[]),
    '-c','mcp_servers.fixture.command='+JSON.stringify(process.execPath),
    '-c','mcp_servers.fixture.args='+JSON.stringify([evaluator]),prompt
  ]:[
    '--provider',provider??process.env.SAM_STEP_PROVIDER??'magpie','--model',model??process.env.SAM_STEP_MODEL??'agy-cli/gemini-4-hydrogen',
    '--mode','json','--print','--no-session','--no-builtin-tools','--no-context-files','--no-extensions','--no-skills','--no-update-check',
    '--tools',[...tools.map(tool=>'mcp__shared_memory__'+tool),'write_fixture_result'].join(','),'-e',extension,
    ...tools.filter(tool=>['memory_recall','memory_resolve_project'].includes(tool))
      .flatMap(tool=>['--tool-override','mcp__shared_memory__'+tool+'=allow']),
    '--',prompt
  ];
  const startedAt=performance.now();
  return new Promise((done,reject)=>{
    const child=spawn(cli,args,{cwd:work,env,stdio:['ignore','pipe','pipe']});
    child.stdout.setEncoding('utf8');
    let stdout='',stderr='',pending='',race;
    const events=[],arrival=[];
    const collect=line=>{
      const event=parse(line);
      if(!event)return;
      events.push(event);arrival.push(performance.now());
      if(afterRecall&&!race&&(event.type==='item.completed'&&event.item?.type==='mcp_tool_call'&&event.item.tool==='memory_recall' ||
          event.type==='tool_execution_end'&&event.toolName?.endsWith('memory_recall'))) {
        race=afterRecall();
        race.catch(()=>{});
      }
    };
    child.stdout.on('data',part=>{
      stdout+=part;pending+=part;
      const lines=pending.split('\n');pending=lines.pop();
      for(const line of lines)collect(line);
    });
    child.stderr.on('data',part=>stderr+=part);
    const timer=setTimeout(()=>child.kill('SIGTERM'),timeoutMs);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',async(code,signal)=>{
      clearTimeout(timer);
      if(pending)collect(pending);
      try {await race;}catch(error){reject(error);return;}
      const codex=events.filter(e=>e.type==='item.completed').map(e=>e.item);
      const step=events.filter(e=>e.type==='message_end').map(e=>e.message).filter(m=>m?.role==='assistant');
      const finals=client==='codex'?codex.filter(i=>i.type==='agent_message').map(i=>i.text):
        step.flatMap(i=>i.content.filter(c=>c.type==='text').map(c=>c.text));
      const callStarts=new Map(),trace=[];
      for(const [index,event] of events.entries()){
        if(event.type==='item.started'&&event.item?.type==='mcp_tool_call')callStarts.set(event.item.id,{index});
        if(event.type==='tool_execution_start')callStarts.set(event.toolCallId,{index,args:event.args});
        const item=event.type==='item.completed'&&event.item?.type==='mcp_tool_call'?event.item:null;
        if(!item&&event.type!=='tool_execution_end')continue;
        const start=callStarts.get(item?.id??event.toolCallId);
        const result=item?.result??event.result;
        const response=decode(result);
        const raw=JSON.stringify(result??event);
        const content=result?.content;
        const replyBytes=Array.isArray(content)?content.reduce((n,block)=>n+Buffer.byteLength(block.text??''),0):null;
        trace.push({name:memoryName(item?.tool??event.toolName),args:item?.arguments??start?.args??{},result:raw,response,
          ok:item?item.status==='completed'&&!result?.isError&&!result?.is_error:!event.isError,
          reply_bytes:replyBytes,elapsed_ms:start?arrival[index]-arrival[start.index]:null});
      }
      const usage=client==='codex'?events.filter(e=>e.type==='turn.completed').map(({usage:u})=>({
        input_tokens:numeric(u?.input_tokens),cached_input_tokens:numeric(u?.cached_input_tokens),output_tokens:numeric(u?.output_tokens)
      })):step.map(({usage:u,model,provider})=>({
        model,provider,input_tokens:numeric(u?.input)===null?null:u.input+(numeric(u.cacheRead)??0)+(numeric(u.cacheWrite)??0),
        cached_input_tokens:numeric(u?.cacheRead),cache_write_input_tokens:numeric(u?.cacheWrite),output_tokens:numeric(u?.output)
      }));
      const calls=trace.filter(call=>call.ok&&call.name?.startsWith('memory_'));
      const recalls=trace.filter(call=>call.name==='memory_recall').map(call=>call.args);
      const errors=events.filter(e=>e.type==='turn.failed'||e.type==='error'||e.message?.errorMessage)
        .map(e=>e.error?.message??e.message?.errorMessage??e.message).filter(Boolean);
      done({code,signal,last:finals.at(-1)?.trim(),stdout,recalls,calls,trace,usage,elapsed_ms:performance.now()-startedAt,errors,
        tool_errors:trace.filter(call=>!call.ok).slice(0,2).map(call=>({tool:call.name,message:call.result.slice(0,650)})),
        stderr:code?stderr.split('\n').filter(s=>/error|failed|unauth|forbid|limit|unavailable/i.test(s)).slice(-3).map(s=>s.slice(0,360)):[]});
    });
  });
}
