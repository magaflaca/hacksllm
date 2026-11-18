// Permisos por modo: normal (pregunta cambios y comandos), edits (acepta ediciones), plan (solo lectura) y yolo.

export const MODES = ['normal', 'edits', 'plan', 'yolo'];
export const MODE_INFO = {
  normal: { label: 'normal', hint: 'pregunta antes de cambiar archivos o ejecutar', color: 'soft' },
  edits: { label: 'acepta ediciones', hint: 'edita sin preguntar, pregunta comandos', color: 'plum' },
  plan: { label: 'modo plan', hint: 'investiga y propone, sin cambiar nada', color: 'ok' },
  yolo: { label: 'sin preguntas', hint: 'hace todo sin preguntar', color: 'err' },
};

// Regla para "no volver a preguntar": en comandos, el programa y su subcomando (npm test, git status).
export function ruleFor(tool, input) {
  if (tool.name === 'shell') {
    const words = String(input.command ?? '').trim().split(/\s+/);
    const prefix = words.slice(0, /^(npm|pnpm|yarn|bun|git|cargo|go|python|python3|pip|uv|npx|docker|make|dotnet|deno)$/.test(words[0]) ? 2 : 1).join(' ');
    return `shell:${prefix}`;
  }
  return tool.name;
}

function matches(rule, tool, input) {
  if (rule === tool.name) return true;
  if (rule.startsWith('shell:') && tool.name === 'shell') {
    const prefix = rule.slice(6).trim();
    const command = String(input.command ?? '').trim();
    // Un comando encadenado solo cuenta si todas sus partes coinciden.
    return command.split(/\s*(?:&&|\|\||;|\|)\s*/).every((part) => part === prefix || part.startsWith(`${prefix} `));
  }
  return false;
}

// Devuelve 'allow', 'deny' (con motivo) o 'ask'.
export function decide({ tool, input, mode, settings, session }) {
  const rules = [...(settings?.allow ?? []), ...session];
  if ((settings?.deny ?? []).some((rule) => matches(rule, tool, input))) return { verdict: 'deny', reason: 'bloqueado por las reglas del proyecto' };
  if (tool.kind === 'read' || tool.kind === 'net' || tool.kind === 'meta') return { verdict: 'allow' };
  if (mode === 'yolo') return { verdict: 'allow' };
  if (mode === 'plan' && tool.kind === 'write')
    return { verdict: 'deny', reason: 'estas en modo plan: no cambies archivos todavia. presenta el plan con exit_plan_mode.' };
  if (rules.some((rule) => matches(rule, tool, input))) return { verdict: 'allow' };
  if (mode === 'edits' && tool.kind === 'write') return { verdict: 'allow' };
  return { verdict: 'ask' };
}
