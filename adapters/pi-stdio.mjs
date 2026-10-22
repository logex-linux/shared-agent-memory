// Compatibility bridge for Pi releases before native mcp.json support.
// It uses exactly the same STDIO server and schemas, with no extra data store.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

export default function sharedMemory(pi) {
  let client;
  pi.on('session_start',async()=>{
    const config=process.env.SHARED_MEMORY_CONFIG;
    if(!config)throw new Error('Set SHARED_MEMORY_CONFIG to an absolute configuration file');
    client=new Client({name:'pi-shared-memory-bridge',version:'0.1.0'});
    await client.connect(new StdioClientTransport({
      command:process.env.SHARED_MEMORY_NODE??process.execPath,
      args:[fileURLToPath(new URL('../dist/mcp/server.js',import.meta.url))],
      env:{SHARED_MEMORY_CONFIG:config},stderr:'pipe'
    }));
    const {tools}=await client.listTools();
    for(const tool of tools)pi.registerTool({
      name:'mcp__shared_memory__'+tool.name,label:tool.name,description:tool.description,
      parameters:tool.inputSchema,
      async execute(_id,params,signal){
        const result=await client.callTool({name:tool.name,arguments:params},undefined,{signal});
        if(result.isError)throw new Error(result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'));
        return {content:result.content,details:{server:'shared_memory'}};
      }
    });
  });
  pi.on('before_agent_start',async event=>{
    if(!client)return;
    return {systemPrompt:event.systemPrompt+'\n\n'+(client.getInstructions()??'')};
  });
  pi.on('session_shutdown',async()=>{await client?.close();});
}
