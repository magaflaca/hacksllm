// Registro de herramientas.
import { edit, ls, read, write } from './fs.mjs';
import { ask, exitPlan, task, todo } from './meta.mjs';
import { glob, grep } from './search.mjs';
import { shell, shellKill, shellOutput } from './shell.mjs';
import { webFetch, webSearch } from './web.mjs';

export const BUILTIN = [read, write, edit, ls, glob, grep, shell, shellOutput, shellKill, webFetch, webSearch, todo, task, ask, exitPlan];

// Herramientas para un agente: los subagentes no lanzan otros ni preguntan, y un agente propio puede limitarlas.
export function toolset({ extra = [], sub = false, allow = null, plan = false } = {}) {
  let list = [...BUILTIN, ...extra];
  if (sub) list = list.filter((tool) => !['task', 'ask_user', 'exit_plan_mode'].includes(tool.name));
  if (!plan) list = list.filter((tool) => tool.name !== 'exit_plan_mode');
  if (allow) list = list.filter((tool) => allow.includes(tool.name) || tool.kind === 'meta');
  return list;
}

export const schema = (tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters });
