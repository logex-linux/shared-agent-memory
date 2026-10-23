// Apply observability only to a separately compiled, frozen v0.4.1 baseline.
import {readFile,copyFile} from 'node:fs/promises';import {resolve,join} from 'node:path';import {execFileSync} from 'node:child_process';
const target=resolve(process.argv[2]??'.local/v042/baseline/dist'),patch=resolve('bench/performance/v041-profile.patch');
// patch exits on mismatch; never substitute optimization code into the baseline.
execFileSync('/usr/bin/patch',['--dry-run','-p1','-i',patch],{cwd:target,stdio:'inherit'});
execFileSync('/usr/bin/patch',['-p1','-i',patch],{cwd:target,stdio:'inherit'});
await copyFile(resolve('dist/retrieval/profile.js'),join(target,'retrieval/profile.js'));
console.log(JSON.stringify({instrumented:target,ranking_unchanged:true}));
