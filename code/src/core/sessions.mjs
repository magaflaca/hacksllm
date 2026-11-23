// Sesiones por proyecto en ~/.bichi/projects/<carpeta>/<id>.json, para continuar (-c) o retomar (-r, /resume).
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { HOME, writeJson } from '../config.mjs';

const PROJECTS = path.join(HOME, 'projects');
const KEEP = 100;

export const newSessionId = () => randomUUID().slice(0, 8);

// Nombre de carpeta estable para un proyecto: la ruta con separadores cambiados por guiones.
export const projectSlug = (cwd) => path.resolve(cwd).replace(/[:\\/]+/g, '-').replace(/^-+/, '').slice(-120) || 'raiz';
export const projectDir = (cwd) => path.join(PROJECTS, projectSlug(cwd));

export function saveSession(session) {
  if (!session.messages.length) return;
  const first = session.messages.find((message) => message.role === 'user' && typeof message.content === 'string' && !message.content.startsWith('('));
  session.title ??= (first?.content ?? 'sesion').replace(/<archivo[\s\S]*?<\/archivo>/g, '').replace(/\s+/g, ' ').trim().slice(0, 70);
  session.updated = Date.now();
  writeJson(path.join(projectDir(session.cwd), `${session.id}.json`), session);
}

function readDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const file = path.join(dir, name);
      try {
        const { id, title, cwd, updated, messages } = JSON.parse(readFileSync(file, 'utf8'));
        const info = statSync(file);
        return { id, title, cwd, updated: updated ?? info.mtimeMs, count: messages?.length ?? 0, size: info.size, file };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function listSessions(cwd = null) {
  const dirs = cwd ? [projectDir(cwd)] : existsSync(PROJECTS) ? readdirSync(PROJECTS).map((name) => path.join(PROJECTS, name)) : [];
  const all = dirs.flatMap(readDir).sort((a, b) => b.updated - a.updated);
  if (cwd) for (const old of all.slice(KEEP)) unlinkSync(old.file);
  return all.slice(0, KEEP);
}

// Una conversacion guardada a mitad de turno (ventana cerrada, cuelgue) puede tener llamadas a herramientas sin su
// resultado; los modelos rechazan eso, asi que al retomarla cada llamada huerfana recibe un "(interrumpido)".
function mend(session) {
  const answered = new Set((session.messages ?? []).filter((message) => message.role === 'tool').map((message) => message.tool_call_id));
  const out = [];
  let missing = [];
  const flush = () => {
    out.push(...missing.map((call) => ({ role: 'tool', tool_call_id: call.id, name: call.function?.name, content: '(interrumpido: bichi se cerro antes de terminar)' })));
    missing = [];
  };
  for (const message of session.messages ?? []) {
    // Los resultados que si llegaron siguen a su llamada; los que faltan se ponen al acabar ese bloque.
    if (message.role !== 'tool') flush();
    out.push(message);
    missing.push(...(message.tool_calls ?? []).filter((call) => !answered.has(call.id)));
  }
  flush();
  session.messages = out;
  return session;
}

export function loadSession(id) {
  if (!id || !existsSync(PROJECTS)) return null;
  for (const name of readdirSync(PROJECTS)) {
    const dir = path.join(PROJECTS, name);
    const exact = path.join(dir, `${id}.json`);
    const file = existsSync(exact) ? exact : readdirSync(dir).map((entry) => path.join(dir, entry)).find((entry) => path.basename(entry).startsWith(id));
    if (file) {
      try {
        return mend(JSON.parse(readFileSync(file, 'utf8')));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function ago(time) {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}
