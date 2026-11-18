// Sesiones guardadas en ~/.bichi/sessions para continuar (-c) o retomar (-r, /resume).
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { paths, writeJson } from '../config.mjs';

const KEEP = 200;

export const newSessionId = () => randomUUID().slice(0, 8);

export function saveSession(session) {
  if (!session.messages.length) return;
  const first = session.messages.find((message) => message.role === 'user' && typeof message.content === 'string');
  session.title ??= (first?.content ?? 'sesion').replace(/\s+/g, ' ').slice(0, 70);
  session.updated = Date.now();
  writeJson(path.join(paths.sessions, `${session.id}.json`), session);
}

export function listSessions(cwd = null) {
  let files;
  try {
    files = readdirSync(paths.sessions).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const all = files
    .map((name) => {
      const file = path.join(paths.sessions, name);
      try {
        const { id, title, cwd: dir, updated, messages } = JSON.parse(readFileSync(file, 'utf8'));
        return { id, title, cwd: dir, updated: updated ?? statSync(file).mtimeMs, count: messages?.length ?? 0, file };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.updated - a.updated);
  // Limpieza: solo se guardan las ultimas.
  for (const old of all.slice(KEEP)) unlinkSync(old.file);
  const kept = all.slice(0, KEEP);
  return cwd ? kept.filter((session) => path.resolve(session.cwd ?? '') === path.resolve(cwd)) : kept;
}

export function loadSession(id) {
  try {
    return JSON.parse(readFileSync(path.join(paths.sessions, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export function ago(time) {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}
