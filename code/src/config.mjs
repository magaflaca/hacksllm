// Configuracion y estado de bichi code en ~/.bichi (o BICHI_HOME).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSION = '1.8.2';
export const HOME = process.env.BICHI_HOME || path.join(os.homedir(), '.bichi');
export const SITE = process.env.BICHI_SITE || 'https://llm.hacks.win';

export const paths = {
  config: path.join(HOME, 'config.json'),
  state: path.join(HOME, 'state.json'),
  sessions: path.join(HOME, 'sessions'),
  memory: path.join(HOME, 'BICHI.md'),
  commands: path.join(HOME, 'commands'),
  agents: path.join(HOME, 'agents'),
  settings: path.join(HOME, 'settings.json'),
  bin: path.join(HOME, 'bin'),
};

export const DEFAULTS = {
  providers: {},
  model: 'auto',
  effort: 'medium',
  realNames: false,
  mode: 'normal',
  autoCompact: true,
  shell: 'auto',
  verbose: false,
};

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Escritura atomica: nunca deja un json a medias si se corta.
export function writeJson(file, data, mode) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, mode ? { mode } : undefined);
  renameSync(temp, file);
}

export const configExists = () => existsSync(paths.config);

export function loadConfig() {
  const stored = readJson(paths.config, {});
  return { ...DEFAULTS, ...stored, providers: { ...stored.providers } };
}

// La config guarda claves: solo legible por el usuario.
export const saveConfig = (config) => writeJson(paths.config, config, 0o600);

export function loadState() {
  return { cooldowns: {}, history: [], models: {}, toolModes: {}, dropped: {}, ...readJson(paths.state, {}) };
}

let stateTimer = null;
export function saveState(state) {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => writeJson(paths.state, state), 200);
  stateTimer.unref?.();
}

export function flushState(state) {
  clearTimeout(stateTimer);
  writeJson(paths.state, state);
}

// Ajustes de proyecto y de usuario: permisos permitidos, hooks y servidores MCP.
export function loadSettings(cwd) {
  const user = readJson(paths.settings, {});
  const project = readJson(path.join(cwd, '.bichi', 'settings.json'), {});
  const local = readJson(path.join(cwd, '.bichi', 'settings.local.json'), {});
  const merge = (key) => [...(user[key] ?? []), ...(project[key] ?? []), ...(local[key] ?? [])];
  return {
    allow: merge('allow'),
    deny: merge('deny'),
    hooks: { ...user.hooks, ...project.hooks, ...local.hooks },
    mcpServers: { ...user.mcpServers, ...project.mcpServers, ...local.mcpServers },
  };
}

export function addProjectAllow(cwd, rule) {
  const file = path.join(cwd, '.bichi', 'settings.local.json');
  const data = readJson(file, {});
  data.allow = [...new Set([...(data.allow ?? []), rule])];
  writeJson(file, data);
}
