import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {globSync} from 'node:fs';
import {resolve} from 'node:path';
import {isolatedWorkspace} from './artifacts.mjs';

const work = await isolatedWorkspace('test');
const args = process.argv.slice(2);
const reportFlags = args.filter(arg => arg.startsWith('--report-dir='));
if (reportFlags.length > 1 || reportFlags[0] === '--report-dir=')
  throw Error('Use --report-dir=PATH to export test reports');
const report = reportFlags.length ? resolve(reportFlags[0].slice(13)) : undefined;
const testArgs = args.filter(arg => !arg.startsWith('--report-dir='));
const files = testArgs.some(arg => !arg.startsWith('-') && arg.endsWith('.mjs')) ? [] : globSync('tests/*.test.mjs').sort();
const env = {
  ...process.env,
  SAM_TEST_WORKSPACE: work,
  SAM_TEST_REPORT_DIR: report ?? ''
};
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...testArgs, ...files], {env, stdio: 'inherit'});
const [code] = await once(child, 'close');
process.exitCode = code ?? 1;
