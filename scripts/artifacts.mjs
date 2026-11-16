import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {chmod, copyFile, link, lstat, mkdir, mkdtemp, mkdtempDisposable, readFile, readdir, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {constants as osConstants, tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const repository = fileURLToPath(new URL('../', import.meta.url));
const marker = 'sam-run.json';
const oneDay = 24 * 60 * 60 * 1000;
const retainedMaxBytes = 128 * 1024 * 1024;
const signalGroup = process.platform !== 'win32';

function own(stat) {
  return process.getuid === undefined || stat.uid === process.getuid();
}

async function ownedDirectory(path, create = false, privateMode = true) {
  if (create) await mkdir(path, {mode: 0o700, recursive: true});
  const info = await lstat(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!info) return false;
  if (!info.isDirectory() || !own(info) || privateMode && process.getuid && (info.mode & 0o077))
    throw Error('Expected an owned directory with restricted permissions: ' + path);
  return true;
}

async function scratchRoot(create) {
  const path = join(await realpath(tmpdir()), 'shared-agent-memory-runs');
  await ownedDirectory(path, create);
  return path;
}

async function retainedRoot(create) {
  const local = join(repository, '.local');
  const path = join(local, 'runs');
  if (await ownedDirectory(local, create, false)) await ownedDirectory(path, create);
  return path;
}

function alive(pid, group = false) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function markedRuns(root, state) {
  if (!await ownedDirectory(root)) return [];
  const runs = [];
  for (const entry of await readdir(root, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    try {
      const manifest = join(path, marker);
      const info = await lstat(manifest);
      if (!info.isFile() || !own(info) || info.size > 4096) continue;
      const data = JSON.parse(await readFile(manifest, 'utf8'));
      if (data.version !== 1 || data.id !== entry.name || data.state !== state ||
          typeof data.task !== 'string' || !Number.isFinite(data.started)) continue;
      runs.push({...data, path});
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
  return runs;
}

async function retainedBytes(path) {
  let bytes = 0;
  for (const entry of await readdir(path, {withFileTypes: true})) {
    const item = join(path, entry.name);
    if (entry.isFile()) bytes += (await lstat(item)).size;
    if (entry.isDirectory()) bytes += await retainedBytes(item);
  }
  return bytes;
}

export async function pruneArtifacts({apply = false, abandoned = true, now = Date.now()} = {}) {
  const retained = await markedRuns(await retainedRoot(false), 'finished');
  const old = retained.filter(run => Number.isFinite(run.finished))
    .sort((a, b) => b.finished - a.finished || a.id.localeCompare(b.id));
  const candidates = [];
  const counts = new Map();
  let used = 0;
  for (const run of old) {
    const bytes = await retainedBytes(run.path).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (bytes === undefined) continue;
    const count = counts.get(run.task) ?? 0;
    const reason = now - run.finished > 7 * oneDay ? 'age' : count >= 3 ? 'count'
      : used + bytes > retainedMaxBytes ? 'size' : null;
    if (reason) candidates.push({path: run.path, reason, bytes});
    else {
      used += bytes;
      counts.set(run.task, count + 1);
    }
  }
  if (abandoned && signalGroup) {
    for (const run of await markedRuns(await scratchRoot(false), 'running')) {
      if (now - run.started < oneDay || !Number.isSafeInteger(run.worker) || alive(run.pid) || alive(run.worker, true)) continue;
      candidates.push({path: run.path, reason: 'abandoned'});
    }
  }
  if (apply) {
    for (const {path} of candidates) await rm(path, {recursive: true, force: true});
  }
  return {applied: apply, candidates};
}

function keepOption(args) {
  const flags = args.filter(arg => arg.startsWith('--keep='));
  const keep = flags[0]?.slice(7) ?? 'none';
  if (flags.length > 1 || !['none', 'failed', 'all'].includes(keep))
    throw Error('Use one of --keep=none, --keep=failed or --keep=all');
  return {keep, args: args.filter(arg => !arg.startsWith('--keep='))};
}

function mirror(stream, output) {
  let tail = Buffer.alloc(0);
  stream.on('data', chunk => {
    if (!output.write(chunk)) {
      stream.pause();
      output.once('drain', () => stream.resume());
    }
    tail = Buffer.concat([tail, chunk]).subarray(-128 * 1024);
  });
  return () => tail;
}

async function retainDiagnostics(path, metadata, tails) {
  const root = await retainedRoot(true);
  await using stage = await mkdtempDisposable(join(root, '.pending-'));
  const reports = join(path, 'reports');
  let bytes = tails.reduce((sum, tail) => sum + tail.length, 0);
  for (const entry of await readdir(reports, {withFileTypes: true}).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = join(reports, entry.name);
    const size = (await lstat(file)).size;
    if (bytes + size + 4096 > retainedMaxBytes) continue;
    await copyFile(file, join(stage.path, entry.name));
    bytes += size;
  }
  for (const [i, channel] of ['stdout', 'stderr'].entries()) {
    if (tails[i].length) await writeFile(join(stage.path, channel + '.log'), tails[i], {mode: 0o600});
  }
  const id = basename(path);
  const destination = join(root, id);
  await writeFile(join(stage.path, marker), JSON.stringify({...metadata, id, state: 'finished', finished: Date.now()}), {mode: 0o600});
  await rename(stage.path, destination);
  await pruneArtifacts({apply: true, abandoned: false});
  return destination;
}

async function run(entry, args, task, keep) {
  const temporary = await mkdtempDisposable(join(await scratchRoot(true), task + '-'));
  const path = temporary.path;
  const metadata = {version: 1, id: basename(path), task, state: 'running', started: Date.now(), pid: process.pid, node: process.version};
  const env = {...process.env, TMPDIR: path, TMP: path, TEMP: path,
    SAM_ARTIFACT_ENTRY: entry, SAM_ARTIFACT_WORK: path, SAM_ARTIFACT_KEEP: keep};
  let child, completed;
  let interrupted;
  const handlers = {};
  const capture = keep !== 'none';
  try {
    await writeFile(join(path, marker), JSON.stringify(metadata), {mode: 0o600, flag: 'wx'});
    child = spawn(process.execPath, [...process.execArgv, entry, ...args], {
      env, detached: signalGroup, stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit'
    });
    completed = once(child, 'close');
    // Mark rejections handled while persisting the process group for abandoned runs.
    completed.catch(() => {});
    const tails = capture ? [mirror(child.stdout, process.stdout), mirror(child.stderr, process.stderr)] : [];
    for (const signal of ['SIGINT', 'SIGTERM']) {
      handlers[signal] = () => {
        const forward = interrupted ? 'SIGKILL' : signal;
        interrupted ??= signal;
        if (!child.pid) return;
        try { process.kill(signalGroup ? -child.pid : child.pid, forward); }
        catch (error) { if (error.code !== 'ESRCH') process.stderr.write(error.message + '\n'); }
      };
      process.on(signal, handlers[signal]);
    }
    metadata.worker = child.pid;
    const pending = join(path, '.running.json');
    await writeFile(pending, JSON.stringify(metadata), {mode: 0o600});
    await rename(pending, join(path, marker));
    const [code, signal] = await completed;
    const exit = interrupted || signal ? 128 + osConstants.signals[interrupted ?? signal] : (code ?? 1);
    if (keep === 'all' || (keep === 'failed' && exit)) {
      let message;
      try { message = 'Diagnostics: ' + await retainDiagnostics(path, metadata, tails.map(tail => tail())); }
      catch (error) { message = 'Could not retain diagnostics: ' + error.message; }
      await new Promise(resolveWrite => process.stderr.write(message + '\n', resolveWrite));
    }
    return exit;
  } catch (error) {
    if (child?.pid && alive(child.pid, signalGroup)) {
      handlers.SIGTERM?.();
      await Promise.race([completed?.catch(() => {}), delay(1000)]);
    }
    throw error;
  } finally {
    for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
    // The child process group can outlive its leader when a test kills a worker.
    if (signalGroup && child?.pid) {
      const deadline = Date.now() + 1000;
      while (alive(child.pid, true) && Date.now() < deadline) await delay(25);
    }
    if (child?.pid && alive(child.pid, signalGroup)) {
      await new Promise(resolveWrite => process.stderr.write('Workspace retained for a running process: ' + path + '\n', resolveWrite));
    } else {
      await temporary.remove();
    }
  }
}

// Historical benchmark entry points keep their arguments and run under one
// supervisor that owns the workspace and all its child processes.
export async function isolatedWorkspace(task) {
  const entry = resolve(process.argv[1]);
  if (process.env.SAM_ARTIFACT_ENTRY === entry && process.env.SAM_ARTIFACT_WORK)
    return process.env.SAM_ARTIFACT_WORK;
  const {keep, args} = keepOption(process.argv.slice(2));
  process.exit(await run(entry, args, task, keep));
}

export async function writeRunReport(workspace, value, {directory, name = 'report.json'} = {}) {
  const capture = workspace && ['failed', 'all'].includes(process.env.SAM_ARTIFACT_KEEP);
  if (!capture && !directory) return undefined;
  if (basename(name) !== name || !name.endsWith('.json')) throw Error('Report name must be a JSON filename');
  let path;
  const data = JSON.stringify(value, null, 2) + '\n';
  for (const target of [capture && join(workspace, 'reports'), directory]) {
    if (!target) continue;
    await mkdir(target, {recursive: true, mode: 0o700});
    const pending = join(target, '.' + randomUUID() + '.tmp');
    try {
      await writeFile(pending, data, {mode: 0o600, flag: 'wx'});
      path = join(target, name);
      await rename(pending, path);
    } finally {
      await rm(pending, {force: true});
    }
  }
  return path;
}

export async function reportDirectory(output, prefix) {
  if (!output) return undefined;
  await mkdir(output, {recursive: true, mode: 0o700});
  return mkdtemp(join(await realpath(output), prefix + '-'));
}

export async function publishFrozenFile(source, destination) {
  await chmod(source, 0o600);
  try {
    await link(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await using staging = await mkdtempDisposable(join(dirname(destination), '.sam-publish-'));
    const ready = join(staging.path, basename(destination));
    await copyFile(source, ready);
    await link(ready, destination);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply')) throw Error('Usage: npm run artifacts:prune -- [--apply]');
  console.log(JSON.stringify(await pruneArtifacts({apply: args.includes('--apply')}), null, 2));
}
