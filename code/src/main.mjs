// bichi code: agente de programacion en la terminal, con los modelos de hacksllm y otros proveedores.
import { existsSync, statSync } from 'node:fs';

import path from 'node:path';
import { configExists, flushState, loadConfig, loadSettings, loadState, saveConfig, SITE, VERSION } from './config.mjs';
import { Agent } from './core/agent.mjs';
import { Router } from './core/router.mjs';
import { listSessions, loadSession, newSessionId, saveSession } from './core/sessions.mjs';
import { activeProviders } from './providers.mjs';
import { startMcp, stopMcp } from './tools/mcp.mjs';
import { killAll } from './tools/shell.mjs';
import { autoUpdate, update } from './updater.mjs';
import { c, dim } from './ui/term.mjs';

const HELP = `${c.brand('bichi code')} ${dim(VERSION)}  tu bicho programador

uso
  bichi                     abre bichi en la carpeta actual
  bichi "tarea"             abre bichi y le pide la tarea
  bichi <carpeta>           abre bichi en esa carpeta
  bichi -p "tarea"          sin interfaz: hace la tarea e imprime la respuesta
  bichi -c                  continua la ultima conversacion de esta carpeta
  bichi -r [id]             retoma una conversacion
  bichi update              actualiza bichi code

opciones
  -m, --model <nombre>      modelo (auto, bichihacks, bichi-max, …)
  --effort <low|medium|high>
  --plan                    empieza en modo plan
  --yolo                    no pregunta nada (cuidado)
  --edits                   acepta ediciones sin preguntar
  -v, --version
`;

function parseArgs(argv) {
  const options = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '-p' || arg === '--print') options.print = next() ?? '';
    else if (arg === '-c' || arg === '--continue') options.continue = true;
    else if (arg === '-r' || arg === '--resume') options.resume = argv[i + 1] && !argv[i + 1].startsWith('-') ? next() : true;
    else if (arg === '-m' || arg === '--model') options.model = next();
    else if (arg === '--effort') options.effort = next();
    else if (arg === '--plan') options.mode = 'plan';
    else if (arg === '--yolo' || arg === '--dangerously-skip-permissions') options.mode = 'yolo';
    else if (arg === '--edits') options.mode = 'edits';
    else if (arg === '-v' || arg === '--version') options.version = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else options.positional.push(arg);
  }
  return options;
}

async function updateNow() {
  process.stdout.write(`${c.brand('●')} buscando la ultima version…\n`);
  const latest = await update({ force: process.argv.includes('--force') });
  process.stdout.write(latest ? `  ${c.ok('actualizado')} ${VERSION} → ${latest}\n` : `  ${c.ok('ya tienes la ultima')} (${VERSION})\n`);
}

async function headless({ config, state, router, cwd, settings, prompt, mode, session }) {
  const err = (text) => process.stderr.write(`${text}\n`);
  const agent = new Agent({
    config,
    state,
    router,
    cwd,
    settings,
    extraTools: await startMcp(settings.mcpServers),
    mode: () => mode,
    ui: {
      onText: (text) => process.stdout.write(text),
      onAssistantEnd: ({ text, calls }) => text && calls && process.stdout.write('\n'),
      onToolStart: (view) => err(dim(`● ${view.label.title} ${view.label.arg ?? ''}`)),
      onToolDenied: (view, reason) => err(dim(`● ${view.label.title}: ${reason}`)),
      onSwitch: (info) => err(dim(`  ${info.reason}${info.to ? ', sigo con otro modelo' : ''}`)),
    },
  });
  if (session) agent.messages = session.messages;
  const current = session ?? { id: newSessionId(), cwd, created: Date.now(), messages: agent.messages };
  try {
    await agent.send(prompt);
    process.stdout.write('\n');
  } finally {
    current.messages = agent.messages;
    saveSession(current);
    flushState(state);
    stopMcp();
    killAll();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.version) return console.log(VERSION);
  if (options.help) return console.log(HELP);
  if (options.positional[0] === 'update') return updateNow();

  let cwd = process.cwd();
  if (options.positional.length === 1 && existsSync(options.positional[0]) && statSync(options.positional[0]).isDirectory()) {
    cwd = path.resolve(options.positional.shift());
    process.chdir(cwd);
  }
  const config = loadConfig();
  if (options.model) config.model = options.model;
  if (options.effort) config.effort = options.effort;
  const state = loadState();
  const router = new Router({ config, state });
  const settings = loadSettings(cwd);

  let session = null;
  if (options.continue) session = listSessions(cwd)[0] ? loadSession(listSessions(cwd)[0].id) : null;
  if (typeof options.resume === 'string') session = loadSession(options.resume) ?? loadSession(listSessions().find((item) => item.id.startsWith(options.resume))?.id);

  if (options.print !== undefined) {
    const piped = process.stdin.isTTY ? '' : await readPiped();
    const prompt = [options.print, ...options.positional, piped].filter(Boolean).join('\n\n');
    if (!activeProviders(config).length) throw new Error('no hay api key configurada: ejecuta bichi una vez para configurarla');
    return headless({ config, state, router, cwd, settings, prompt, mode: options.mode ?? config.mode, session });
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('bichi necesita una terminal interactiva (o usa -p "tarea")');

  const { App } = await import('./app.mjs');
  const extraTools = [];
  const app = new App({ config, state, router, cwd, settings, extraTools, session });
  if (options.mode) app._mode = options.mode; // un --plan o --yolo de la linea de comandos no se guarda
  process.on('uncaughtException', (error) => {
    app.term.leave();
    process.stderr.write(`\n${c.err('error inesperado:')} ${error.stack ?? error.message}\n`);
    process.exit(1);
  });
  app.start();

  autoUpdate(config, (version) => app.note(`bichi ${version} descargado e instalado · se usa al volver a abrir bichi`, c.ok));

  startMcp(settings.mcpServers).then((tools) => {
    extraTools.push(...tools);
    if (tools.length) app.print(dim(`  mcp: ${tools.length} herramientas listas`));
  });

  if (!configExists() || !activeProviders(config).length) await firstRun(app);
  const commands = await import('./commands.mjs');
  if (options.resume === true) await commands.runCommand(app, 'resume', '', '/resume');
  else if (session) commands.resumeInto(app, session);

  const initial = options.positional.join(' ').trim();
  if (initial) await app.send(initial);
}

// Lo que llega por tuberia (cat log | bichi -p "explica"); si no llega nada enseguida, no se espera.
function readPiped() {
  return new Promise((resolve) => {
    let data = '';
    const finish = () => {
      process.stdin.pause();
      resolve(data);
    };
    let timer = setTimeout(finish, 300);
    process.stdin.on('data', (chunk) => {
      data += chunk;
      clearTimeout(timer);
      timer = setTimeout(finish, 2000);
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function firstRun(app) {
  const { setKey, providersMenu } = await import('./settings-ui.mjs');
  app.print(
    [
      `  ${c.ice('hola, soy bichi.')} para empezar necesito tu api key de hacksllm.`,
      `  la consigues gratis en ${c.sky(`${SITE}/#/api`)}`,
      dim('  (esc para usar otro proveedor: NVIDIA, Mistral, Groq, OpenRouter…)'),
      '',
    ].join('\n'),
  );
  while (true) {
    const key = await app.field({ title: 'api key de hacksllm', secret: true, hint: 'pegala aqui; se guarda solo en tu computadora (~/.bichi/config.json)' });
    if (key === null) {
      await providersMenu(app);
      if (activeProviders(app.config).length) break;
      continue;
    }
    if (await setKey(app, 'hacksllm', { key })) break;
  }
  app.config.model ??= 'auto';
  saveConfig(app.config);
  app.print(`\n  ${c.ok('listo.')} pideme lo que quieras: ${dim('"explicame este proyecto", "arregla los tests", "haz una web de…"')}\n`);
}

main().catch((error) => {
  process.stderr.write(`${c.err('bichi:')} ${error.message}\n`);
  process.exit(1);
});
