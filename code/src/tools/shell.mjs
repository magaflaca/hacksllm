// Shell: comandos en primer plano con limite de tiempo y en segundo plano (servidores, watchers).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { invalidate } from './files.mjs';

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

function start(command, ctx) {
  const shell = detectShell(ctx.config?.shell);
  return spawn(shell.file, shell.args(command), {
    cwd: ctx.cwd,
    env: { ...process.env, BICHI: '1', GIT_PAGER: 'cat', PAGER: 'cat', TERM: process.env.TERM ?? 'xterm-256color' },
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const background = new Map();
let nextId = 1;

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
    const child = start(command, ctx);
    let output = '';
    const collect = (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 4 * MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + output.slice(-2 * MAX_OUTPUT);
      ctx.progress?.(output);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    if (input.background) {
      const id = `bg${nextId++}`;
      const job = { id, command, child, output: '', read: 0, exit: null };
      child.stdout.removeAllListeners('data');
      child.stderr.removeAllListeners('data');
      const keep = (chunk) => (job.output = (job.output + chunk.toString('utf8')).slice(-200_000));
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      child.on('close', (code) => (job.exit = code ?? -1));
      background.set(id, job);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { content: `en segundo plano con id ${id}. salida inicial:\n${job.output.slice(0, 4000) || '(nada aun)'}`, summary: `en segundo plano (${id})` };
    }

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
    const job = background.get(input.id);
    if (!job) throw new Error(`no hay proceso ${input.id}. activos: ${[...background.keys()].join(', ') || 'ninguno'}`);
    const fresh = job.output.slice(job.read);
    job.read = job.output.length;
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
    const job = background.get(input.id);
    if (!job) throw new Error(`no hay proceso ${input.id}`);
    killTree(job.child);
    background.delete(input.id);
    return { content: 'detenido', summary: 'detenido' };
  },
};

export const backgroundJobs = () => [...background.values()];
export const killAll = () => background.forEach((job) => killTree(job.child));
