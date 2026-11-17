import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {description,save} from './fixture-result-step.mjs';

const value=z.string().min(1).max(90).regex(/^[A-Za-z0-9_\-|]+$/);
const server=new McpServer({name:'fixture-result',version:'1'});
server.registerTool('write_fixture_result',{description,inputSchema:{value},
  annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},save);
await server.connect(new StdioServerTransport());
