// Skills: carpetas con un SKILL.md (frontmatter name y description) que bichi carga cuando hacen falta.
// Se buscan en el proyecto (.bichi/skills y .claude/skills) y en el usuario (~/.bichi/skills y ~/.claude/skills),
// asi que las skills de Claude Code tambien sirven.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME } from '../config.mjs';
import { frontmatter } from './project.mjs';

function roots(cwd) {
  return [
    { dir: path.join(cwd, '.bichi', 'skills'), scope: 'proyecto' },
    { dir: path.join(cwd, '.claude', 'skills'), scope: 'proyecto' },
    { dir: path.join(HOME, 'skills'), scope: 'usuario' },
    { dir: path.join(os.homedir(), '.claude', 'skills'), scope: 'usuario' },
  ];
}

let cache = { key: '', at: 0, list: [] };

export function listSkills(cwd) {
  if (cache.key === cwd && Date.now() - cache.at < 5000) return cache.list;
  const found = new Map();
  for (const { dir, scope } of roots(cwd)) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name, 'SKILL.md');
      try {
        if (!statSync(file).isFile()) continue;
        const { meta, body } = frontmatter(readFileSync(file, 'utf8'));
        const id = (meta.name || name).toLowerCase().replace(/\s+/g, '-');
        if (!found.has(id)) found.set(id, { name: id, description: meta.description ?? '', body, dir: path.dirname(file), scope });
      } catch {
        /* sin SKILL.md */
      }
    }
  }
  cache = { key: cwd, at: Date.now(), list: [...found.values()] };
  return cache.list;
}

export const findSkill = (cwd, name) => listSkills(cwd).find((skill) => skill.name === String(name).toLowerCase());

export function skillText(skill, args = '') {
  return `# Skill ${skill.name}\n(archivos de la skill en ${skill.dir}; lee los que el texto mencione si los necesitas)\n\n${skill.body}${args ? `\n\n# Pedido\n${args}` : ''}`;
}

export const skillTool = {
  name: 'skill',
  kind: 'meta',
  get description() {
    return 'Carga las instrucciones de una skill (un procedimiento experto guardado por el usuario) para seguirlas. Usala cuando la tarea encaje con la descripcion de una skill de la lista del sistema.';
  },
  parameters: { type: 'object', properties: { name: { type: 'string', description: 'nombre de la skill' } }, required: ['name'] },
  label: (input) => ({ title: 'Skill', arg: input.name }),
  async run(input, ctx) {
    const skill = findSkill(ctx.cwd, input.name);
    if (!skill) throw new Error(`no hay skill "${input.name}". disponibles: ${listSkills(ctx.cwd).map((item) => item.name).join(', ') || 'ninguna'}`);
    return { content: skillText(skill), summary: 'cargada' };
  },
};
