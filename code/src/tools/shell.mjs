// Shell: comandos en primer plano con limite de tiempo y en segundo plano (servidores, watchers).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { invalidate } from './files.mjs';
import * as jobs from './jobs.mjs';

const MAX_OUTPUT = 30_000;

let detected;
// Bash si existe (tambien Git Bash en Windows), si no PowerShell.
export function detectShell(preference = 'auto') {
  if (detected && preference === 'auto') return detected;
  const win = process.platform === 'win32';
  const gitBash = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]
    .filter(Boolean)
    .map((base) => path.join(base, 'Git', 'bin', 'bash.exe'))
    .find((file) => existsSync(file));
  const pwsh = { name: 'powershell', file: 'powershell.exe', args: (command) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command] };
  const bash = (file) => ({ name: 'bash', file, args: (command) => ['-c', command] });
  let shell;
  if (preference === 'powershell') shell = pwsh;
  else if (preference === 'bash') shell = bash(win ? gitBash ?? 'bash' : '/bin/bash');
  else if (win) shell = gitBash ? bash(gitBash) : pwsh;
  else shell = bash(existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
  if (preference === 'auto') detected = shell;
  return shell;
}

function clip(text) {
  if (text.length <= MAX_OUTPUT) return text;
  const head = text.slice(0, 8000);
  const tail = text.slice(-20000);
  return `${head}\n\n… (${text.length - 28000} caracteres omitidos) …\n\n${tail}`;
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

export const shellEnv = () => ({ ...process.env, BICHI: '1', GIT_PAGER: 'cat', PAGER: 'cat', TERM: process.env.TERM ?? 'xterm-256color' });

function start(command, ctx) {
  const shell = detectShell(ctx.config?.shell);
  return spawn(shell.file, shell.args(command), {
    cwd: ctx.cwd,
    env: shellEnv(),
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const readSoFar = new Map(); // cuanto de cada log ya se le dio al modelo con shell_output

export const shell = {
  name: 'shell',
  kind: 'exec',
  get description() {
    const kind = detectShell().name;
    return `Ejecuta un comando en ${kind === 'bash' ? 'bash' : 'PowerShell'} en la carpeta del proyecto y devuelve la salida (stdout y stderr). Cada llamada empieza en la carpeta del proyecto. Para servidores o procesos largos usa background: true y luego shell_output.`;
  },
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'comando a ejecutar' },
      description: { type: 'string', description: 'que hace, en 5 a 10 palabras' },
      timeout: { type: 'number', description: 'segundos maximos (por defecto 120, maximo 600)' },
      background: { type: 'boolean', description: 'dejarlo corriendo en segundo plano' },
    },
    required: ['command'],
  },
  label: (input) => ({ title: 'Shell', arg: String(input.command ?? '').replace(/\s+/g, ' ') }),
  async run(input, ctx) {
    const command = String(input.command ?? '');
    if (!command.trim()) throw new Error('comando vacio');

    if (input.background) {
      const job = jobs.startJob(detectShell(ctx.config?.shell), command, ctx.cwd, shellEnv());
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const first = jobs.tail(job, 4000);
      readSoFar.set(job.id, first.length);
      return { content: `en segundo plano con id ${job.id} (sigue vivo aunque se cierre bichi). salida inicial:\n${first || '(nada aun)'}`, summary: `en segundo plano (shell ${job.number})` };
    }

    const child = start(command, ctx);
    let output = '';
    const collect = (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 4 * MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + output.slice(-2 * MAX_OUTPUT);
      ctx.progress?.(output);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const seconds = Math.min(600, Math.max(1, Number(input.timeout) || 120));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, seconds * 1000);
    const onAbort = () => killTree(child);
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    const code = await new Promise((resolve) => {
      child.on('close', (exit) => resolve(exit));
      child.on('error', (error) => {
        output += `\n${error.message}`;
        resolve(-1);
      });
    });
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onAbort);
    invalidate();
    // Saltos de Windows fuera; de una barra de progreso con \r queda solo su ultimo estado.
    const plain = output
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.split('\r').pop())
      .join('\n');
    const text = clip(plain.trimEnd());
    const note = timedOut ? `\n(cortado tras ${seconds}s)` : ctx.signal?.aborted ? '\n(interrumpido por el usuario)' : code ? `\n(salio con codigo ${code})` : '';
    return { content: (text || '(sin salida)') + note, output: text, exit: code, summary: timedOut ? 'tiempo agotado' : code ? `codigo ${code}` : null };
  },
};

export const shellOutput = {
  name: 'shell_output',
  kind: 'read',
  description: 'Lee la salida nueva de un comando en segundo plano (por su id) y si sigue vivo.',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  label: (input) => ({ title: 'Salida', arg: input.id }),
  async run(input) {
    const all = jobs.list();
    const job = all.find((item) => item.id === input.id);
    if (!job) throw new Error(`no hay proceso ${input.id}. activos: ${all.map((item) => item.id).join(', ') || 'ninguno'}`);
    const output = job.output;
    const fresh = output.slice(Math.min(readSoFar.get(job.id) ?? 0, output.length));
    readSoFar.set(job.id, output.length);
    return { content: `${job.exit === null ? 'sigue corriendo' : `termino con codigo ${job.exit}`}\n${clip(fresh) || '(sin salida nueva)'}`, summary: job.exit === null ? 'corriendo' : `termino (${job.exit})` };
  },
};

export const shellKill = {
  name: 'shell_kill',
  kind: 'exec',
  description: 'Detiene un comando en segundo plano.',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  label: (input) => ({ title: 'Detener', arg: input.id }),
  async run(input) {
    if (!jobs.stop(input.id)) throw new Error(`no hay proceso ${input.id}`);
    return { content: 'detenido', summary: 'detenido' };
  },
};

export const backgroundJobs = () => jobs.list();

// Detiene un proceso en segundo plano (desde la barra de abajo o /jobs).
export const stopJob = (id) => jobs.stop(id);

// Al salir y elegir detenerlos.
export const killAll = () => jobs.list().forEach((job) => job.exit === null && jobs.stop(job.id));
