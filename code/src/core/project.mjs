// Lo que aporta el proyecto y el usuario: memoria (BICHI.md y compatibles), agentes y comandos propios.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { paths } from '../config.mjs';

const MEMORY_NAMES = ['BICHI.md', 'AGENTS.md', 'CLAUDE.md'];

// Memoria de usuario y de cada carpeta desde la raiz del disco hasta el proyecto (la mas cercana pesa mas).
export function memoryFiles(cwd) {
  const found = [];
  if (existsSync(paths.memory)) found.push({ scope: 'usuario', file: paths.memory });
  const chain = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    chain.unshift(dir);
    if (path.dirname(dir) === dir) break;
  }
  for (const dir of chain) {
    for (const name of [path.join('.bichi', 'BICHI.md'), ...MEMORY_NAMES, path.join('.claude', 'CLAUDE.md')]) {
      const file = path.join(dir, name);
      if (existsSync(file)) {
        found.push({ scope: dir === cwd ? 'proyecto' : 'carpeta superior', file });
        break;
      }
    }
    const local = [path.join(dir, '.bichi', 'BICHI.local.md'), path.join(dir, 'BICHI.local.md')].find((file) => existsSync(file)) ?? '';
    if (existsSync(local)) found.push({ scope: 'local', file: local });
  }
  return found;
}

export function loadMemory(cwd) {
  return memoryFiles(cwd)
    .map(({ scope, file }) => {
      try {
        const text = readFileSync(file, 'utf8').trim();
        return text ? `## ${path.basename(file)} (${scope}: ${file})\n${text.slice(0, 40000)}` : '';
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}

export function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([\w-]+):\s*(.*)$/.exec(line);
    if (pair) meta[pair[1]] = pair[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: text.slice(match[0].length).trim() };
}

function markdownDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const { meta, body } = frontmatter(readFileSync(path.join(dir, name), 'utf8'));
      return { name: (meta.name || name.slice(0, -3)).toLowerCase().replace(/\s+/g, '-'), meta, body, file: path.join(dir, name) };
    });
}

export function loadAgents(cwd) {
  const all = [...markdownDir(paths.agents), ...markdownDir(path.join(cwd, '.claude', 'agents')), ...markdownDir(path.join(cwd, '.bichi', 'agents'))];
  const byName = new Map(all.map((agent) => [agent.name, agent]));
  return [...byName.values()].map(({ name, meta, body, file }) => ({
    name,
    description: meta.description ?? '',
    tools: meta.tools ? meta.tools.split(/[,\s]+/).filter(Boolean) : null,
    model: meta.model ?? null,
    prompt: body,
    file,
  }));
}

export function loadCommands(cwd) {
  const all = [...markdownDir(paths.commands), ...markdownDir(path.join(cwd, '.claude', 'commands')), ...markdownDir(path.join(cwd, '.bichi', 'commands'))];
  const byName = new Map(all.map((command) => [command.name, command]));
  return [...byName.values()].map(({ name, meta, body, file }) => ({ name, description: meta.description ?? 'comando propio', body, file }));
}

export function expandCommand(command, args) {
  return command.body.includes('$ARGUMENTS') ? command.body.replaceAll('$ARGUMENTS', args) : `${command.body}${args ? `\n\n${args}` : ''}`;
}
