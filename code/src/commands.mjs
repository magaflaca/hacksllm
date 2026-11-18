// Comandos con barra.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadSettings, paths, saveConfig, VERSION } from './config.mjs';
import { MODE_INFO, MODES } from './core/permissions.mjs';
import { expandCommand, loadAgents, loadCommands, memoryFiles } from './core/project.mjs';
import { listSessions, loadSession, newSessionId } from './core/sessions.mjs';
import { catalog, displayName } from './providers.mjs';
import { openConfig, pickEffort, pickModel, providersMenu, sessionOptions, setKey } from './settings-ui.mjs';
import { servers } from './tools/mcp.mjs';
import { backgroundJobs } from './tools/shell.mjs';
import { notice, todoLines, userBlock } from './ui/blocks.mjs';
import { bold, c, cols, dim, pad } from './ui/term.mjs';

const INIT_PROMPT = `Analiza este proyecto y crea (o mejora, si ya existe) un archivo BICHI.md en la raiz con lo que un agente de programacion necesita saber para trabajar aqui:
- para que sirve el proyecto y como esta organizado (carpetas importantes)
- como instalar, ejecutar, probar, hacer el build y el lint (comandos exactos)
- convenciones de codigo y estilo que se ven en el repo
- cosas no obvias: configuraciones, servicios externos, trampas conocidas
Se concreto y breve (unas 40 a 80 lineas). No inventes comandos: verificalos en package.json, Makefile, pyproject o lo que haya.`;

const REVIEW_PROMPT = `Revisa los cambios pendientes del repositorio (git diff y git diff --staged; si no hay, el ultimo commit). Busca bugs reales, casos borde, problemas de seguridad y de rendimiento, y cosas que se puedan simplificar. Lista los hallazgos por gravedad con ruta:linea y una propuesta concreta para cada uno. No cambies archivos.`;

export const COMMANDS = [
  { name: 'help', description: 'comandos y atajos' },
  { name: 'model', description: 'elegir modelo (o auto)' },
  { name: 'effort', description: 'esfuerzo: bajo, medio o alto' },
  { name: 'mode', description: 'modo: normal, acepta ediciones, plan, sin preguntas' },
  { name: 'plan', description: 'entrar o salir del modo plan' },
  { name: 'config', description: 'ajustes, proveedores y claves' },
  { name: 'providers', description: 'proveedores de modelos y sus claves' },
  { name: 'key', description: 'poner tu api key de hacksllm' },
  { name: 'names', description: 'ver u ocultar los nombres reales de los modelos' },
  { name: 'clear', description: 'conversacion nueva' },
  { name: 'compact', description: 'resumir la conversacion para liberar contexto' },
  { name: 'resume', description: 'retomar una conversacion anterior' },
  { name: 'undo', description: 'deshacer los cambios en archivos del ultimo turno' },
  { name: 'todos', description: 'ver la lista de tareas' },
  { name: 'init', description: 'crear BICHI.md con lo que bichi debe saber del proyecto' },
  { name: 'memory', description: 'ver y abrir los archivos de memoria' },
  { name: 'review', description: 'revisar los cambios pendientes del repo' },
  { name: 'agents', description: 'agentes propios (.bichi/agents)' },
  { name: 'commands', description: 'comandos propios (.bichi/commands)' },
  { name: 'mcp', description: 'servidores MCP conectados' },
  { name: 'permissions', description: 'reglas de permisos activas' },
  { name: 'status', description: 'modelo, contexto, tokens y version' },
  { name: 'jobs', description: 'procesos en segundo plano' },
  { name: 'export', description: 'guardar la conversacion en un .md' },
  { name: 'copy', description: 'copiar la ultima respuesta' },
  { name: 'update', description: 'actualizar bichi code' },
  { name: 'exit', description: 'salir' },
  { name: 'quit', description: 'salir', hidden: true },
  { name: 'new', description: 'conversacion nueva', hidden: true },
  { name: 'reset', description: 'conversacion nueva', hidden: true },
  { name: 'sessions', description: 'retomar', hidden: true },
  { name: 'login', description: 'clave', hidden: true },
];

const table = (rows) => rows.map(([a, b]) => `  ${c.sky(pad(a, 16))} ${c.soft(b)}`).join('\n');

function openFile(file) {
  const editor = process.env.VISUAL || process.env.EDITOR;
  const [command, args] = editor ? [editor, [file]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', file]] : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function copyText(text) {
  const [command, args] = process.platform === 'win32' ? ['clip', []] : process.platform === 'darwin' ? ['pbcopy', []] : ['xclip', ['-selection', 'clipboard']];
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.end(text);
  });
}

export async function runCommand(app, name, args, raw) {
  const print = (text) => app.print(text);
  switch (name) {
    case 'help':
      print(['', bold(c.brand('  comandos')), table(COMMANDS.filter((command) => !command.hidden).map((command) => [`/${command.name}`, command.description])), '', bold(c.brand('  atajos'))].join('\n'));
      return print((await import('./app.mjs')).shortcutsHelp());
    case 'model':
      if (args) {
        const entry = catalog(app.config).find((item) => [item.alias, item.id, item.key].includes(args));
        if (args === 'auto' || entry) {
          app.config.model = args === 'auto' ? 'auto' : entry.key;
          app.router.current = entry ?? null;
          saveConfig(app.config);
          return print(notice(`modelo: ${app.modelLabel()}`, c.ok));
        }
        return print(notice(`no conozco "${args}"`, c.warn));
      }
      return pickModel(app);
    case 'effort':
      return pickEffort(app, { bajo: 'low', medio: 'medium', alto: 'high' }[args] ?? args);
    case 'mode': {
      const wanted = MODES.find((mode) => mode === args || MODE_INFO[mode].label === args);
      if (wanted) app.mode = wanted;
      else {
        const choice = await app.choose({ title: 'modo', options: MODES.map((mode) => ({ label: MODE_INFO[mode].label, hint: MODE_INFO[mode].hint, value: mode, selected: mode === app.mode })), escape: null });
        if (!choice) return;
        app.mode = choice;
      }
      return print(notice(`modo ${MODE_INFO[app.mode].label}`, c.ok));
    }
    case 'plan':
      app.mode = app.mode === 'plan' ? 'normal' : 'plan';
      print(notice(app.mode === 'plan' ? 'modo plan: bichi investiga y te propone un plan antes de tocar nada' : 'modo normal', c.ok));
      if (args) return app.send(args);
      return;
    case 'config':
      return openConfig(app);
    case 'providers':
      return providersMenu(app);
    case 'key':
    case 'login':
      return setKey(app, 'hacksllm', args ? { key: args } : {});
    case 'names':
      app.config.realNames = !app.config.realNames;
      saveConfig(app.config);
      return print(notice(app.config.realNames ? 'nombres reales visibles' : 'nombres bichi', c.ok));
    case 'clear':
    case 'new':
    case 'reset':
      app.saveSession();
      app.session = { id: newSessionId(), cwd: app.cwd, created: Date.now(), messages: [] };
      app.agent.messages = app.session.messages;
      app.agent.todos = [];
      app.agent.turns = [];
      app.agent.usage = { prompt: 0, completion: 0, lastPrompt: 0 };
      app.screen.clear();
      return app.banner();
    case 'compact':
      return app.run(async () => {
        const done = await app.agent.compact(args, app.agent.controller?.signal);
        if (!done) print(notice('no hay suficiente conversacion para resumir'));
      });
    case 'resume':
    case 'sessions': {
      const sessions = listSessions(app.cwd).filter((session) => session.id !== app.session.id);
      if (!sessions.length) return print(notice('no hay conversaciones anteriores en esta carpeta'));
      const id = await app.choose({ title: 'retomar conversacion', options: sessionOptions(sessions.slice(0, 15)), escape: null });
      if (!id) return;
      return resumeInto(app, loadSession(id));
    }
    case 'undo': {
      const files = await app.agent.undo();
      return print(files.length ? notice(`deshecho en ${files.length} archivos: ${files.map((file) => path.relative(app.cwd, file)).join(', ')}`, c.ok) : notice('no hay cambios que deshacer'));
    }
    case 'todos':
      return print(app.agent.todos.length ? ['', ...todoLines(app.agent.todos).map((line) => `  ${line}`)].join('\n') : notice('no hay tareas'));
    case 'init':
      return app.send(INIT_PROMPT, { display: '/init' });
    case 'review':
      return app.send(`${REVIEW_PROMPT}${args ? `\n\nFoco: ${args}` : ''}`, { display: `/review ${args}`.trim() });
    case 'memory': {
      const files = memoryFiles(app.cwd);
      const project = path.join(app.cwd, 'BICHI.md');
      const options = [...files.map(({ scope, file }) => ({ label: file, hint: scope, value: file }))];
      if (!files.some(({ file }) => file === project)) options.push({ label: project, hint: 'crear memoria del proyecto', value: project });
      if (!files.some(({ file }) => file === paths.memory)) options.push({ label: paths.memory, hint: 'crear memoria de usuario', value: paths.memory });
      const file = await app.choose({ title: 'memoria', body: [dim('bichi lee estos archivos al empezar. tambien puedes escribir #nota para agregar algo.')], options, escape: null });
      if (!file) return;
      if (!existsSync(file)) writeFileSync(file, '# Memoria para bichi\n\n');
      openFile(file);
      return print(notice(`abierto ${file}`));
    }
    case 'agents': {
      const agents = loadAgents(app.cwd);
      if (!agents.length)
        return print(
          [notice('no hay agentes propios.'), dim(`  crea .bichi/agents/<nombre>.md con:\n  ---\n  name: revisor\n  description: revisa codigo buscando bugs\n  tools: read, grep, glob\n  ---\n  instrucciones del agente…`)].join('\n'),
        );
      return print(['', ...agents.map((agent) => `  ${c.sky(agent.name)} ${c.soft(agent.description)}`)].join('\n'));
    }
    case 'commands': {
      const commands = loadCommands(app.cwd);
      if (!commands.length) return print([notice('no hay comandos propios.'), dim('  crea .bichi/commands/<nombre>.md; usa $ARGUMENTS para lo que escribas despues del comando.')].join('\n'));
      return print(['', ...commands.map((command) => `  ${c.sky(`/${command.name}`)} ${c.soft(command.description)}`)].join('\n'));
    }
    case 'mcp':
      if (!servers.length) return print([notice('no hay servidores MCP.'), dim('  agregalos en .bichi/settings.json o ~/.bichi/settings.json:\n  { "mcpServers": { "nombre": { "command": "npx", "args": ["-y", "paquete-mcp"] } } }')].join('\n'));
      return print(['', ...servers.map((server) => `  ${server.error ? c.err('●') : c.ok('●')} ${c.sky(server.name)} ${c.soft(server.error ?? `${server.tools.length} herramientas`)}`)].join('\n'));
    case 'permissions': {
      const settings = loadSettings(app.cwd);
      const rows = [...settings.allow.map((rule) => ['permitido', rule]), ...[...app.agent.sessionRules].map((rule) => ['esta sesion', rule]), ...settings.deny.map((rule) => ['bloqueado', rule])];
      return print(rows.length ? ['', ...rows.map(([kind, rule]) => `  ${c.soft(pad(kind, 12))} ${c.sky(rule)}`)].join('\n') : notice(`sin reglas. modo actual: ${MODE_INFO[app.mode].label}`));
    }
    case 'status': {
      const usage = app.agent.usage;
      const entries = catalog(app.config);
      const resting = entries.filter((entry) => (app.state.cooldowns[entry.key] ?? 0) > Date.now());
      return print(
        [
          '',
          table([
            ['version', VERSION],
            ['modelo', app.modelLabel()],
            ['esfuerzo', app.config.effort],
            ['modo', MODE_INFO[app.mode].label],
            ['contexto', `${Math.round(app.agent.contextUsed() / 1000)}k de ${Math.round(app.agent.contextLimit() / 1000)}k`],
            ['tokens', `${usage.prompt} entrada · ${usage.completion} salida`],
            ['modelos', `${entries.length} disponibles${resting.length ? `, ${resting.length} descansando (${resting.map((entry) => displayName(app.config, entry)).join(', ')})` : ''}`],
            ['sesion', app.session.id],
            ['carpeta', app.cwd],
          ]),
        ].join('\n'),
      );
    }
    case 'jobs': {
      const jobs = backgroundJobs();
      return print(jobs.length ? ['', ...jobs.map((job) => `  ${job.exit === null ? c.ok('●') : c.soft('○')} ${c.sky(job.id)} ${job.command}`)].join('\n') : notice('no hay procesos en segundo plano'));
    }
    case 'export': {
      const file = path.resolve(app.cwd, args || `bichi-${app.session.id}.md`);
      const body = app.agent.messages
        .filter((message) => message.role === 'user' || (message.role === 'assistant' && message.content))
        .map((message) => (message.role === 'user' ? `## tu\n\n${message.content}` : `## bichi\n\n${message.content}`))
        .join('\n\n');
      writeFileSync(file, `# conversacion con bichi\n\n${body}\n`);
      return print(notice(`guardado en ${file}`, c.ok));
    }
    case 'copy': {
      const last = [...app.agent.messages].reverse().find((message) => message.role === 'assistant' && message.content);
      if (!last) return print(notice('aun no hay respuestas'));
      return print((await copyText(last.content)) ? notice('copiado', c.ok) : notice('no pude copiar', c.warn));
    }
    case 'update':
      return print(notice('para actualizar ejecuta en otra terminal: bichi update'));
    case 'exit':
    case 'quit':
      return app.exit();
    default: {
      const custom = loadCommands(app.cwd).find((command) => command.name === name);
      if (custom) return app.send(expandCommand(custom, args), { display: raw });
      return print(notice(`no existe /${name}. /help para ver los comandos`, c.warn));
    }
  }
}

export function resumeInto(app, session) {
  if (!session) return app.print(notice('no encontre esa conversacion', c.warn));
  app.saveSession();
  app.session = session;
  app.agent.messages = session.messages;
  app.agent.todos = session.todos ?? [];
  app.agent.turns = [];
  const columns = cols();
  const recent = session.messages.filter((message) => (message.role === 'user' && typeof message.content === 'string') || (message.role === 'assistant' && message.content)).slice(-6);
  app.print(['', notice(`retomando "${session.title}"`, c.ok), ...recent.flatMap((message) => ['', ...(message.role === 'user' ? userBlock(message.content.slice(0, 600), columns) : [`${c.ice('●')} ${dim(message.content.slice(0, 400).replace(/\n+/g, ' '))}`])])].join('\n'));
}
