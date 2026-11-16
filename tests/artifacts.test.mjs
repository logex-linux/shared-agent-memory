import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {access, copyFile, mkdir, mkdtempDisposable, readFile, readdir, readlink, truncate, writeFile, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

const exists = path => access(path).then(() => true, error => {
  if (error.code !== 'ENOENT') throw error;
  return false;
});
const fixtureSource = [
  "import {writeFile} from 'node:fs/promises';",
  "import {join} from 'node:path';",
  "import {isolatedWorkspace,writeRunReport} from './artifacts.mjs';",
  "const work=await isolatedWorkspace('example');",
  "await writeFile(join(work,'fixture.db'),'synthetic');",
  "await writeRunReport(work,{ok: true});",
  "console.log('ready');",
  "if (process.argv[2]==='fail') process.exitCode=7;",
  "if (process.argv[2]==='wait') setInterval(()=>{},1000);"
].join('\n');

async function sandbox(t) {
  const temporary = await mkdtempDisposable(join(tmpdir(), 'sam-run-test-'));
  t.after(() => temporary.remove());
  const {path} = temporary;
  const scripts = join(path, 'scripts'), temp = join(path, 'tmp');
  await mkdir(scripts);
  await mkdir(temp);
  await copyFile(new URL('../scripts/artifacts.mjs', import.meta.url), join(scripts, 'artifacts.mjs'));
  await writeFile(join(scripts, 'fixture.mjs'), fixtureSource);
  const retained = join(path, '.local', 'runs');
  const scratch = join(temp, 'shared-agent-memory-runs');
  const env = {...process.env, TMPDIR: temp, TMP: temp, TEMP: temp};
  const start = (file, ...args) => {
    const child = spawn(process.execPath, [join(scripts, file), ...args], {cwd: path, env});
    const output = {stdout: '', stderr: ''};
    child.stdout.on('data', chunk => { output.stdout += chunk; });
    child.stderr.on('data', chunk => { output.stderr += chunk; });
    const result = once(child, 'close').then(([code, signal]) => ({...output, code, signal}));
    return {child, result};
  };
  const run = (file, ...args) => start(file, ...args).result;
  return {path, retained, scratch, run, start};
}

test('workspaces disappear on success and failure and keep flags retain diagnostics only', async t => {
  const {retained, scratch, run} = await sandbox(t);
  assert.equal((await run('fixture.mjs')).code, 0);
  assert.deepEqual(await readdir(scratch), []);
  assert.equal(await exists(retained), false);
  assert.equal((await run('fixture.mjs', '--keep=failed')).code, 0);
  assert.equal(await exists(retained), false);

  const failed = await run('fixture.mjs', 'fail', '--keep=failed');
  assert.equal(failed.code, 7, failed.stderr);
  assert.deepEqual(await readdir(scratch), []);
  const [id] = await readdir(retained);
  assert.deepEqual((await readdir(join(retained, id))).sort(), ['report.json', 'sam-run.json', 'stdout.log']);
});

test('SIGINT and SIGTERM exit with the original signal status and remove workspaces', {skip: process.platform === 'win32'}, async t => {
  const {scratch, start} = await sandbox(t);
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const {child, result} = start('fixture.mjs', 'wait');
    await Promise.race([
      once(child.stdout, 'data'),
      result.then(value => { throw Error('Workspace worker exited early: ' + value.stderr); })
    ]);
    child.kill(signal);
    const completed = await result;
    assert.equal(completed.code, code, completed.stderr);
    assert.deepEqual(await readdir(scratch), []);
  }
});

test('only marked finished artifacts are retained and pruned by count, age and bytes', async t => {
  const {path, retained, run} = await sandbox(t);
  const results = await Promise.all(Array.from({length: 4}, () => run('fixture.mjs', '--keep=all')));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal((await readdir(retained)).length, 3);
  const protectedDir = join(path, 'protected');
  await mkdir(protectedDir);
  await writeFile(join(protectedDir, 'memory.db'), 'synthetic');
  const shortcut = join(retained, 'shortcut');
  await symlink(protectedDir, shortcut, 'dir');
  await mkdir(join(retained, 'unmanaged'));

  const [first, second] = (await readdir(retained)).filter(name => name.startsWith('example-'));
  const manifest = join(retained, first, 'sam-run.json');
  const data = JSON.parse(await readFile(manifest, 'utf8'));
  await writeFile(manifest, JSON.stringify({...data, finished: 0}));
  const big = join(retained, second, 'partial.log');
  await writeFile(big, '');
  await truncate(big, 128 * 1024 * 1024);
  const previewResult = await run('artifacts.mjs');
  assert.equal(previewResult.code, 0, previewResult.stderr);
  const preview = JSON.parse(previewResult.stdout);
  assert.deepEqual(new Set(preview.candidates.map(candidate => candidate.reason)), new Set(['age', 'size']));
  assert.equal(await exists(manifest), true);
  assert.equal(await exists(big), true);
  const appliedResult = await run('artifacts.mjs', '--apply');
  assert.equal(appliedResult.code, 0, appliedResult.stderr);
  const applied = JSON.parse(appliedResult.stdout);
  assert.equal(applied.applied, true);
  assert.equal(await exists(manifest), false);
  assert.equal(await exists(big), false);
  assert.equal(await readlink(shortcut), protectedDir);
  assert.equal(await exists(join(protectedDir, 'memory.db')), true);
  assert.equal(await exists(join(retained, 'unmanaged')), true);
});

test('abandoned pruning skips recent workspaces and living process groups', {skip: process.platform === 'win32'}, async t => {
  const {scratch, run, start} = await sandbox(t);
  const {child, result} = start('fixture.mjs');
  const stopped = child.pid;
  assert.equal((await result).code, 0);
  const owner = process.pid;
  for (const [id, pid, worker, started] of [
    ['stopped-run', stopped, stopped, 0],
    ['running-owner', owner, stopped, 0],
    ['recent-run', stopped, stopped, Date.now()],
    ['unregistered-worker', stopped, undefined, 0]
  ]) {
    const path = join(scratch, id);
    await mkdir(path, {mode: 0o700});
    await writeFile(join(path, 'sam-run.json'), JSON.stringify({version: 1, id, state: 'running', task: 'example', pid, worker, started}));
  }
  const preview = await run('artifacts.mjs', '--apply');
  assert.equal(preview.code, 0, preview.stderr);
  assert.deepEqual(JSON.parse(preview.stdout).candidates.map(x => x.reason), ['abandoned']);
  assert.deepEqual((await readdir(scratch)).sort(), ['recent-run', 'running-owner', 'unregistered-worker']);
});
