// Benchmark-only telemetry. Never enabled by the installed MCP command.
import {writeSync} from 'node:fs';
const emit=()=>{try{writeSync(2,JSON.stringify({sam_probe:{time:Date.now(),pid:process.pid,memory:process.memoryUsage(),cpu:process.cpuUsage(),resources:process.resourceUsage()}})+'\n');}catch{}};
emit();setInterval(emit,200).unref();
// Count actual pipeline initializations without changing the model or inference protocol.
if(process.env.SAM_BENCH_KERNEL){
 const {pathToFileURL}=await import('node:url');const {BgeEncoder}=await import(pathToFileURL(process.env.SAM_BENCH_KERNEL+'/embedding/bge.js'));
 const original=BgeEncoder.prototype.load;let starts=0,encodes=0;
 BgeEncoder.prototype.load=function(...args){if(!this.ready)starts++;return original.apply(this,args);};
 const encode=BgeEncoder.prototype.encode;BgeEncoder.prototype.encode=function(...args){encodes++;return encode.apply(this,args);};
 setInterval(()=>{try{writeSync(2,JSON.stringify({sam_model:{pid:process.pid,starts,encodes}})+'\n');}catch{}},200).unref();
}
