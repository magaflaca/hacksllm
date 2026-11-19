// Shells en segundo plano (servidores, watchers): corren como procesos independientes con su salida en un log,
// asi siguen vivos aunque cierres bichi. Quedan anotados en ~/.bichi/jobs.json y bichi los vuelve a ver al abrir.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HOME } from '../config.mjs';

const DIR = path.join(HOME, 'jobs');
const REGISTRY = path.join(HOME, 'jobs.json');
const finished = new Map(); // codigo de salida de los que lanzo esta sesion

function load() {
  try {
    return JSON.parse(readFileSync(REGISTRY, 'utf8'));
  } catch {
    return [];
  }
}

const save = (jobs) => {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(REGISTRY, JSON.stringify(jobs, null, 2));
};

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Final del log (lo que el proceso imprimio), sin leer el archivo entero.
export function tail(job, bytes = 200_000) {
  try {
    const { size } = statSync(job.log);
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    const fd = openSync(job.log, 'r');
    readSync(fd, buffer, 0, length, size - length);
    closeSync(fd);
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

// Los que siguen en el registro, con su estado actual. Los muertos de sesiones viejas se olvidan.
let cache = { at: 0, jobs: [] };

export function list() {
  if (Date.now() - cache.at < 1000) return cache.jobs;
  cache = { at: Date.now(), jobs: fresh() };
  return cache.jobs;
}

function fresh() {
  const jobs = load().map((job) => ({ ...job, exit: alive(job.pid) ? null : finished.get(job.id) ?? -1 }));
  const kept = jobs.filter((job) => job.exit === null || finished.has(job.id));
  if (kept.length !== jobs.length) save(kept.map(({ exit, ...job }) => job));
  return kept.map((job) => Object.defineProperty(job, 'output', { get: () => tail(job), enumerable: false }));
}

export function startJob(shellSpec, command, cwd, env) {
  mkdirSync(DIR, { recursive: true });
  const jobs = load();
  const number = Math.max(0, ...jobs.map((job) => job.number ?? 0)) + 1;
  const id = `bg${number}`;
  const log = path.join(DIR, `${id}-${Date.now()}.log`);
  const fd = openSync(log, 'a');
  const child = spawn(shellSpec.file, shellSpec.args(command), { cwd, env, windowsHide: true, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  child.on('exit', (code) => finished.set(id, code ?? -1));
  child.on('error', () => finished.set(id, -1));
  child.unref();
  const job = { id, number, command, pid: child.pid, log, cwd, started: Date.now() };
  save([...jobs, job]);
  cache.at = 0;
  return job;
}

export function stop(id) {
  const jobs = load();
  const job = jobs.find((item) => item.id === id);
  if (!job) return false;
  if (alive(job.pid)) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(job.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else {
      try {
        process.kill(-job.pid, 'SIGTERM');
      } catch {
        try {
          process.kill(job.pid, 'SIGTERM');
        } catch {
          /* ya no estaba */
        }
      }
    }
  }
  save(jobs.filter((item) => item.id !== id));
  cache.at = 0;
  return true;
}
