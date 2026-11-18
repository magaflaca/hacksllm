// /tp: conversaciones de bichi work que el usuario manda a bichi code. Se guardan ligadas a su clave (owner),
// las 20 ultimas y durante 14 dias; bichi code las lista y las importa con la misma clave.
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PageError } from './pages.mjs';

const ROOT = '/opt/hacksllm/data/transport';
const KEEP = 20;
const TTL = 14 * 24 * 3600 * 1000;
export const MAX_BODY = 4 * 1024 * 1024;

const dirOf = (owner) => path.join(ROOT, owner.replace(/[^a-z0-9]/gi, ''));
const valid = (id) => /^[a-f0-9-]{36}$/.test(id ?? '');

async function entries(owner) {
  const dir = dirOf(owner);
  const names = await readdir(dir).catch(() => []);
  const list = await Promise.all(
    names.filter((name) => name.endsWith('.json')).map(async (name) => ({ file: path.join(dir, name), time: (await stat(path.join(dir, name))).mtimeMs })),
  );
  return list.sort((a, b) => b.time - a.time);
}

export async function save(owner, body) {
  const messages = (Array.isArray(body?.messages) ? body.messages : [])
    .filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string')
    .map(({ role, content }) => ({ role, content: content.slice(0, 200_000) }));
  if (!messages.length) throw new PageError(400, 'la conversacion esta vacia');
  const item = {
    id: randomUUID(),
    title: String(body.title ?? '').slice(0, 120) || messages.find((message) => message.role === 'user').content.slice(0, 60),
    remote: typeof body.remote === 'string' && /^[a-z0-9]{16,40}$/.test(body.remote) ? body.remote : null,
    created: Date.now(),
    messages,
  };
  await mkdir(dirOf(owner), { recursive: true });
  await writeFile(path.join(dirOf(owner), `${item.id}.json`), JSON.stringify(item));
  const list = await entries(owner);
  await Promise.all(list.filter((entry, index) => index >= KEEP || Date.now() - entry.time > TTL).map((entry) => rm(entry.file, { force: true })));
  return { id: item.id, title: item.title };
}

export async function list(owner) {
  const items = await Promise.all(
    (await entries(owner)).map(async (entry) => {
      try {
        const { id, title, created, remote, messages } = JSON.parse(await readFile(entry.file, 'utf8'));
        return { id, title, created, remote, count: messages.length };
      } catch {
        return null;
      }
    }),
  );
  return items.filter(Boolean);
}

export async function get(owner, id) {
  if (!valid(id)) return null;
  try {
    return JSON.parse(await readFile(path.join(dirOf(owner), `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export async function remove(owner, id) {
  if (valid(id)) await rm(path.join(dirOf(owner), `${id}.json`), { force: true });
}
