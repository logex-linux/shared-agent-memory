// Isolates manifest verification; does not load the inference pipeline.
import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
const kernel=resolve(process.argv[2]??'dist'),{BgeEncoder}=await import(pathToFileURL(join(kernel,'embedding/bge.js'))),before=process.memoryUsage(),start=performance.now();
const profile=await new BgeEncoder({model_dir:resolve('.local/models/bge-small-zh-v1.5'),dtype:'fp32',threads:2}).profile();console.log(JSON.stringify({ms:performance.now()-start,before,after:process.memoryUsage(),max_rss_kib:process.resourceUsage().maxRSS,profile_id:profile.id}));
