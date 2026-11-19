// Comandos con barra.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadSettings, paths, saveConfig, VERSION } from './config.mjs';
import { MODE_INFO, MODES } from './core/permissions.mjs';
import { importSources, listImports, reduceTranscript, transcriptText, turnsOf } from './core/importer.mjs';
import { downloadPage, listPages, PUBLIC_BASE, publishFolder, removePage, siteFiles, slugify } from './core/pages.mjs';
import { workApi } from './core/work.mjs';
import { isAgy, projectProblem } from './core/agy.mjs';
import { AGY_HINT, setAgy } from './agy-mode.mjs';
import { expandCommand, loadAgents, loadCommands, loadMemory, memoryFiles } from './core/project.mjs';
import { ago, listSessions, loadSession } from './core/sessions.mjs';
import { findSkill, listSkills, skillText } from './core/skills.mjs';
import { schema } from './tools/index.mjs';
import { catalog, displayName } from './providers.mjs';
import { openConfig, pickEffort, pickModel, providersMenu, sessionOptions, setKey } from './settings-ui.mjs';
import { servers } from './tools/mcp.mjs';
import { update } from './updater.mjs';
import { notice, todoLines } from './ui/blocks.mjs';
import { bold, c, dim, pad } from './ui/term.mjs';

const INIT_PROMPT = `Analiza este proyecto y crea (o mejora, si ya existe) el archivo .bichi/BICHI.md (la memoria del proyecto) con lo que un agente de programacion necesita saber para trabajar aqui:
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
  { name: 'agy', description: 'modo agy: el mas capaz, ideal para proyectos grandes; otra vez para volver' },
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
  { name: 'rewind', description: 'volver a un mensaje anterior, con o sin el codigo' },
  { name: 'goal', description: 'objetivo: bichi trabaja solo hasta cumplirlo' },
  { name: 'context', description: 'en que se esta usando el contexto' },
  { name: 'paginas', description: 'bichi paginas: publicar una carpeta, ver, traer o quitar tus webs' },
  { name: 'import', description: 'importar una conversacion de Claude Code o Codex' },
  { name: 'tp', description: 'traer una conversacion de bichi work (web) con sus archivos' },
  { name: 'bichito', description: 'que pase el bichito por la barra (/bichito zzz para verlo dormir)' },
  { name: 'skills', description: 'skills disponibles (.bichi/skills y .claude/skills)' },
  { name: 'todos', description: 'ver la lista de tareas' },
  { name: 'init', description: 'crear BICHI.md con lo que bichi debe saber del proyecto' },
  { name: 'memory', description: 'ver y abrir los archivos de memoria' },
  { name: 'review', description: 'revisar los cambios pendientes del repo' },
  { name: 'agents', description: 'agentes propios (.bichi/agents)' },
  { name: 'commands', description: 'comandos propios (.bichi/commands)' },
  { name: 'mcp', description: 'servidores MCP conectados' },
  { name: 'permissions', description: 'reglas de permisos activas' },
  { name: 'status', description: 'modelo, contexto, tokens y version' },
  { name: 'jobs', description: 'shells en segundo plano: ver lo que hacen o detenerlos' },
  { name: 'export', description: 'guardar la conversacion en un .md' },
  { name: 'copy', description: 'copiar la ultima respuesta' },
  { name: 'rename', description: 'cambiar el nombre de la conversacion' },
  { name: 'update', description: 'buscar e instalar la ultima version' },
  { name: 'exit', description: 'salir' },
  { name: 'quit', description: 'salir', hidden: true },
  { name: 'new', description: 'conversacion nueva', hidden: true },
  { name: 'reset', description: 'conversacion nueva', hidden: true },
  { name: 'sessions', description: 'retomar', hidden: true },
  { name: 'login', description: 'clave', hidden: true },
  { name: 'pages', description: 'bichi paginas', hidden: true },
];

// Sintaxis que se muestra en gris despues del comando, y opciones que se sugieren al escribir el argumento.
export const ARG_HINTS = {
  model: '[modelo]',
  effort: '[bajo|medio|alto]',
  mode: '[normal|edits|plan|yolo]',
  goal: '[objetivo|off]',
  rename: '[nombre]',
  compact: '[que conservar]',
  review: '[en que fijarse]',
  plan: '[tarea]',
  import: '[claude|codex]',
  bichito: '[zzz]',
  paginas: '[publicar]',
  key: '[api key]',
  export: '[archivo.md]',
};

export function argChoices(app, name) {
  switch (name) {
    case 'model':
      return [
        { value: 'auto', hint: 'el mejor disponible, cambia solo si se agota' },
        { value: 'bichi-agy', hint: AGY_HINT },
        ...catalog(app.config).map((entry) => ({ value: entry.alias, hint: entry.note })),
      ];
    case 'effort':
      return [
        { value: 'bajo', hint: 'rapido y directo' },
        { value: 'medio', hint: 'equilibrado' },
        { value: 'alto', hint: 'piensa mas y prueba a fondo' },
      ];
    case 'mode':
      return MODES.map((mode) => ({ value: mode, hint: `${MODE_INFO[mode].label}: ${MODE_INFO[mode].hint}` }));
    case 'goal':
      return [{ value: 'off', hint: 'quitar el objetivo activo' }];
    case 'import':
      return [
        { value: 'claude', hint: 'conversaciones de Claude Code' },
        { value: 'codex', hint: 'conversaciones de Codex' },
      ];
    case 'bichito':
      return [{ value: 'zzz', hint: 'verlo dormir' }];
    case 'paginas':
      return [{ value: 'publicar', hint: 'subir una carpeta con index.html a bichi.hacks.win' }];
    default:
      return [];
  }
}

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
    case 'agy':
      return setAgy(app, !isAgy(app.config.model));
    case 'model':
      if (isAgy(args)) return setAgy(app, true);
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
      return app.clearConversation();
    case 'goal': {
      if (!args) {
        const goal = app.agent.goal;
        if (!goal) return print(notice('sin objetivo. /goal <objetivo> y bichi trabaja solo hasta cumplirlo (esc lo pausa)'));
        if (goal.paused) {
          goal.paused = false;
          goal.rounds = 0;
          print(notice(`sigo con el objetivo: ${goal.text}`, c.ok));
          return app.send(`(sigue con el objetivo: ${goal.text})`, { display: '/goal' });
        }
        return print(notice(`objetivo activo: ${goal.text}`, c.ok));
      }
      if (/^(off|no|quitar|stop)$/i.test(args)) {
        app.agent.goal = null;
        return print(notice('objetivo quitado'));
      }
      app.agent.goal = { text: args, done: false, rounds: 0 };
      return app.send(`Objetivo: ${args}\n\nTrabaja de forma autonoma hasta cumplirlo y verificarlo; cuando este listo llama goal_done.`, { display: `/goal ${args}` });
    }
    case 'context':
      return print(contextReport(app));
    case 'rewind':
      return app.rewind();
    case 'skills': {
      const skills = listSkills(app.cwd);
      if (!skills.length) return print([notice('no hay skills.'), dim('  crea .bichi/skills/<nombre>/SKILL.md (tambien se leen las de .claude/skills y ~/.claude/skills):\n  ---\n  name: mi-skill\n  description: cuando usarla\n  ---\n  instrucciones…')].join('\n'));
      return print(['', ...skills.map((skill) => `  ${c.sky(`/${skill.name}`)} ${c.soft(`${skill.scope} · ${skill.description.slice(0, 90)}`)}`)].join('\n'));
    }
    case 'import':
      return importChat(app, args);
    case 'tp':
      return teleport(app);
    case 'paginas':
    case 'pages':
      return pagesMenu(app, args);
    case 'bichito':
      if (/^(z+|dormir|duerme|sleep)$/i.test(args)) return app.pet.sleep();
      return app.pet.walk();
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
      const project = path.join(app.cwd, '.bichi', 'BICHI.md');
      const options = [...files.map(({ scope, file }) => ({ label: file, hint: scope, value: file }))];
      if (!files.some(({ file }) => file === project)) options.push({ label: project, hint: 'crear memoria del proyecto', value: project });
      if (!files.some(({ file }) => file === paths.memory)) options.push({ label: paths.memory, hint: 'crear memoria de usuario', value: paths.memory });
      const file = await app.choose({ title: 'memoria', body: [dim('bichi lee estos archivos al empezar. tambien puedes escribir #nota para agregar algo.')], options, escape: null });
      if (!file) return;
      if (!existsSync(file)) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, '# Memoria para bichi\n\n');
      }
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
    case 'jobs':
      return app.jobsMenu();
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
    case 'update': {
      app.flash('buscando la ultima version…');
      try {
        const version = await update();
        return print(version ? notice(`bichi ${version} instalado; se usa al volver a abrir bichi (esta sesion sigue con ${VERSION})`, c.ok) : notice(`ya tienes la ultima (${VERSION})`));
      } catch (error) {
        return print(notice(error.message, c.warn));
      }
    }
    case 'rename': {
      const title = args || (await app.field({ title: 'nombre de la conversacion', initial: app.session.title ?? '' }));
      if (!title) return;
      app.rename(title.slice(0, 80));
      return print(notice(`conversacion: ${title.slice(0, 80)}`, c.ok));
    }
    case 'exit':
    case 'quit':
      return app.exit();
    default: {
      const custom = loadCommands(app.cwd).find((command) => command.name === name);
      if (custom) return app.send(expandCommand(custom, args), { display: raw });
      const skill = findSkill(app.cwd, name);
      if (skill) return app.send(skillText(skill, args), { display: raw });
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
  app.replay();
  app.note(`retomando "${session.title}"`, c.ok);
}

// /context: en que se va el contexto, en una cuadricula de 10x10 (cada cuadro es el 1%).
function contextReport(app) {
  const agent = app.agent;
  const limit = agent.contextLimit();
  const tokens = (value) => Math.ceil((typeof value === 'string' ? value.length : JSON.stringify(value).length) / 3.6);
  const memory = loadMemory(app.cwd);
  const system = agent.system();
  const parts = [
    { name: 'sistema', tokens: tokens(system) - tokens(memory), color: c.soft },
    { name: 'memoria (BICHI.md)', tokens: tokens(memory), color: c.plum },
    { name: 'herramientas', tokens: tokens(agent.tools().map(schema)), color: c.warn },
    { name: 'conversacion', tokens: tokens(agent.payload()), color: c.brand },
  ];
  const used = parts.reduce((sum, part) => sum + part.tokens, 0);
  const cells = [];
  for (const part of parts) for (let i = 0; i < Math.round((part.tokens / limit) * 100); i++) cells.push(part.color('■'));
  while (cells.length < 100) cells.push(c.soft('□'));
  const grid = Array.from({ length: 10 }, (_, row) => `  ${cells.slice(row * 10, row * 10 + 10).join(' ')}`);
  const legend = [
    `${bold('contexto')} ${c.soft(`${Math.round(used / 1000)}k de ${Math.round(limit / 1000)}k (${Math.round((used / limit) * 100)}%)`)}`,
    '',
    ...parts.map((part) => `${part.color('■')} ${pad(part.name, 20)} ${c.soft(`${(part.tokens / 1000).toFixed(1)}k`)}`),
    `${c.soft('□')} ${pad('libre', 20)} ${c.soft(`${Math.max(0, (limit - used) / 1000).toFixed(1)}k`)}`,
    '',
    c.soft('al 75% se resume solo con los'),
    c.soft('modelos gratis; /compact a mano'),
  ];
  return ['', ...grid.map((line, i) => `${line}    ${legend[i] ?? ''}`)].join('\n');
}

// /import: trae una conversacion de Claude Code o Codex, reducida para que quepa con holgura.
async function importChat(app, args) {
  const sources = importSources().filter((source) => source.available);
  if (!sources.length) return app.print(notice('no encontre conversaciones de Claude Code (~/.claude/projects) ni de Codex (~/.codex/sessions)', c.warn));
  const sourceId =
    sources.find((source) => source.id === args.toLowerCase())?.id ??
    (sources.length === 1 ? sources[0].id : await app.choose({ title: 'importar desde', options: sources.map((source) => ({ label: source.label, hint: source.root, value: source.id })), escape: null }));
  if (!sourceId) return;
  const list = listImports(sourceId, app.cwd);
  if (!list.length) return app.print(notice('no hay conversaciones para importar', c.warn));
  const file = await app.choose({
    title: `conversaciones de ${sources.find((source) => source.id === sourceId).label}`,
    body: [dim('las de esta carpeta primero')],
    options: list.slice(0, 15).map((entry) => ({ label: entry.title, hint: `${entry.here ? 'esta carpeta · ' : ''}${ago(entry.time)} · ${entry.turns} mensajes · ${Math.round(entry.size / 1024)} KB`, value: entry.file })),
    escape: null,
  });
  if (!file) return;
  const entry = list.find((item) => item.file === file);
  await app.run(async () => {
    const turns = turnsOf(sourceId, file);
    const text = transcriptText(turns);
    const progress = app.add(() => [notice(`importando "${entry.title}" (${Math.round(text.length / 1000)}k caracteres)…`, c.plum)]);
    const reduced = await reduceTranscript(app.router, text, {
      signal: app.agent.controller?.signal,
      onProgress: (part, total) => {
        progress.render = () => [notice(`resumiendo la conversacion con los modelos gratis: parte ${part} de ${total}…`, c.plum)];
        progress.update();
      },
    });
    const label = sourceId === 'claude' ? 'Claude Code' : 'Codex';
    adopt(app, { label, turns, reduced, reply: `Listo, tengo el contexto de la conversacion de ${label}. ¿Seguimos?`, title: `importada: ${entry.title}` });
    app.note(`importada de ${label}${reduced.summarized ? ` y resumida (${Math.round(text.length / 1000)}k → ${Math.round(reduced.text.length / 1000)}k caracteres)` : ''}`, c.ok);
  });
}

// Carpetas de aqui que se pueden publicar (tienen index.html), la actual primero.
function siteFolders(cwd) {
  const found = [];
  const look = (dir, depth) => {
    if (existsSync(path.join(dir, 'index.html'))) found.push(dir);
    if (depth >= 3 || found.length >= 12) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.') && !['node_modules', 'vendor', 'venv', '__pycache__'].includes(entry.name)) look(path.join(dir, entry.name), depth + 1);
  };
  look(cwd, 0);
  return found;
}

// /paginas: tus bichi paginas (bichi.hacks.win/<nombre>/). Abrir, traer aqui para editar, copiar el link,
// quitar, o publicar una carpeta de este proyecto.
async function pagesMenu(app, args) {
  if (/^publica/.test(args)) return publishMenu(app);
  let pages;
  try {
    pages = await listPages(app.config);
  } catch (error) {
    return app.print(notice(`no pude leer tus paginas: ${error.message}`, c.err));
  }
  const choice = await app.choose({
    title: 'bichi paginas',
    body: [dim(pages.length ? `${PUBLIC_BASE.replace('https://', '')}/<nombre>/ · las tuyas` : 'aun no tienes paginas publicadas')],
    options: [
      ...pages.map((page) => ({ label: page.slug, hint: `${ago(page.updated)} · ${page.files} archivos · ${Math.round(page.size / 1024)} KB`, value: page.slug })),
      { label: 'publicar una carpeta de aqui', hint: 'con index.html', value: '\u0000publish' },
    ],
    escape: null,
  });
  if (!choice) return;
  if (choice === '\u0000publish') return publishMenu(app);
  const page = pages.find((item) => item.slug === choice);
  const action = await app.choose({
    title: page.url,
    options: [
      { label: 'abrir en el navegador', value: 'open' },
      { label: `traerla aqui para editarla`, hint: `./${page.slug}/`, value: 'pull' },
      { label: 'copiar el link', value: 'copy' },
      { label: 'quitarla de internet', hint: 'se borra la pagina publicada', value: 'remove' },
    ],
    escape: null,
  });
  if (action === 'open') return (await import('./app.mjs')).openTarget(page.url);
  if (action === 'copy') return app.print(notice((await copyText(page.url)) ? `copiado: ${page.url}` : page.url, c.ok));
  if (action === 'pull') {
    const target = path.join(app.cwd, page.slug);
    const progress = app.add(() => [notice(`trayendo ${page.slug}…`, c.plum)]);
    try {
      const saved = await downloadPage(app.config, page.slug, target, {
        onFile: (n, total) => {
          progress.render = () => [notice(`trayendo ${page.slug}: ${n} de ${total} archivos…`, c.plum)];
          progress.update();
        },
      });
      progress.render = () => [notice(`${saved.length} archivos en ./${page.slug}/ · editalos y publica de nuevo con /paginas publicar`, c.ok)];
    } catch (error) {
      progress.render = () => [notice(`no pude traerla: ${error.message}`, c.err)];
    }
    progress.update();
    return app.refreshFiles();
  }
  if (action === 'remove') {
    const sure = await app.choose({ title: `quitar ${page.url}?`, body: [dim('el link deja de funcionar para todos; tu copia local, si la tienes, se queda')], options: [{ label: 'no', value: false }, { label: 'si, quitarla', value: true }], escape: false });
    if (!sure) return;
    try {
      await removePage(app.config, page.slug);
      app.print(notice(`quitada: ${page.slug}`, c.ok));
    } catch (error) {
      app.print(notice(`no pude quitarla: ${error.message}`, c.err));
    }
  }
}

async function publishMenu(app) {
  const folders = siteFolders(app.cwd);
  if (!folders.length) return app.print(notice('no encontre ninguna carpeta con index.html aqui. pidele a bichi que te haga la web y luego /paginas publicar', c.warn));
  const folder =
    folders.length === 1
      ? folders[0]
      : await app.choose({ title: 'que carpeta publico', options: folders.map((dir) => ({ label: path.relative(app.cwd, dir) || '. (esta carpeta)', value: dir })), escape: null });
  if (!folder) return;
  let files;
  try {
    files = siteFiles(folder);
  } catch (error) {
    return app.print(notice(`no se puede publicar ${path.relative(app.cwd, folder) || 'esta carpeta'}: ${error.message}`, c.warn));
  }
  const name = await app.field({ title: 'nombre de la pagina', initial: slugify(path.basename(folder)), hint: `quedara en ${PUBLIC_BASE.replace('https://', '')}/<nombre>/ · si ya es tuya se reemplaza` });
  if (!name) return;
  const progress = app.add(() => [notice(`publicando ${files.length} archivos…`, c.plum)]);
  try {
    const page = await publishFolder(app.config, folder, name);
    progress.render = () => [notice(`${page.updated ? 'actualizada' : 'publicada'}: \x1b]8;;${page.url}\x07${page.url}\x1b]8;;\x07`, c.ok)];
  } catch (error) {
    progress.render = () => [notice(`no se pudo publicar: ${error.message}`, c.err)];
  }
  progress.update();
}

// Deja una conversacion traida de fuera como la actual: el modelo recibe la version reducida y en pantalla se ve
// la original completa (session.shown), tambien al retomarla despues.
function adopt(app, { label, turns, reduced, extra = '', reply, title }) {
  app.clearConversation();
  app.agent.messages.push(
    { role: 'user', content: `(Conversacion importada de ${label}${reduced.summarized ? ', resumida para ahorrar contexto' : ''}. Continua desde aqui.)\n\n${reduced.text}${extra}` },
    { role: 'assistant', content: reply },
  );
  let budget = 400_000; // lo que se guarda para mostrar; si es enorme, se queda lo ultimo
  const shown = [];
  for (const turn of [...turns].reverse()) {
    budget -= turn.text.length;
    if (budget < 0) break;
    shown.unshift({ role: turn.role, text: turn.text, tools: turn.tools?.slice(0, 20) ?? [] });
  }
  app.session.shown = { from: label, summarized: reduced.summarized, cut: shown.length < turns.length, turns: shown };
  app.session.title = title;
  app.replay();
}

// /tp: conversaciones que mandaste desde bichi work (boton "llevar a bichi code"), con los archivos del espacio
// si siguen en el servidor. Se reducen igual que las importadas.
async function teleport(app) {
  let api;
  try {
    api = workApi(app.config);
  } catch (error) {
    return app.print(notice(`/tp: ${error.message}`, c.warn));
  }
  let items;
  try {
    ({ items } = await api('tp'));
  } catch (error) {
    return app.print(notice(`no pude leer tus conversaciones de work: ${error.message}`, c.err));
  }
  if (!items.length) return app.print(notice('no hay nada para traer. en la web, en work, pulsa "llevar a bichi code" y vuelve a escribir /tp', c.warn));
  const id = await app.choose({
    title: 'traer de bichi work',
    options: items.map((item) => ({ label: item.title, hint: `${ago(item.created)} · ${item.count} mensajes${item.remote ? ' · con espacio de archivos' : ''}`, value: item.id })),
    escape: null,
  });
  if (!id) return;
  const item = await api(`tp/${id}`);
  let files = [];
  if (item.remote) files = await api(`sessions/${item.remote}`).then((session) => session.files ?? []).catch(() => []);
  files = files.filter((file) => !file.path.split('/').some((part) => part.startsWith('.')));
  let target = null;
  if (files.length) {
    const folder = (item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'bichi-work');
    const where = await app.choose({
      title: `${files.length} ${files.length === 1 ? 'archivo' : 'archivos'} en el espacio de work`,
      options: [
        { label: `traerlos a ./${folder}/`, value: path.join(app.cwd, folder) },
        { label: 'traerlos a esta carpeta', hint: 'sobrescribe si ya existen', value: app.cwd },
        { label: 'solo la conversacion', value: '\u0000none' },
      ],
      escape: '\u0000none',
    });
    if (where !== '\u0000none') target = where;
  }
  await app.run(async () => {
    const saved = [];
    if (target) {
      const progress = app.add(() => [notice(`descargando ${files.length} archivos…`, c.plum)]);
      for (const file of files.slice(0, 300)) {
        const destination = path.resolve(target, file.path);
        if (!destination.startsWith(path.resolve(target))) continue;
        const data = await api(`sessions/${item.remote}/files/${file.path.split('/').map(encodeURIComponent).join('/')}`, { raw: true }).catch(() => null);
        if (!data) continue;
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, data);
        saved.push(path.relative(app.cwd, destination).split(path.sep).join('/'));
        progress.render = () => [notice(`descargando archivos: ${saved.length} de ${files.length}…`, c.plum)];
        progress.update();
      }
      progress.render = () => [notice(`${saved.length} archivos en ${path.relative(app.cwd, target) || '.'}`, c.ok)];
      progress.update();
    }
    // Traidos a una carpeta nueva estando fuera de un proyecto (carpeta de usuario, raiz): esa pasa a ser el proyecto.
    if (saved.length && target !== app.cwd && projectProblem(app.cwd)?.reason !== 'system' && projectProblem(app.cwd)) app.moveTo(target);
    const turns = item.messages.map((message) => ({ role: message.role === 'user' ? 'user' : 'assistant', text: String(message.content ?? '') }));
    const text = turns.map((turn) => `## ${turn.role === 'user' ? 'usuario' : 'bichi work'}\n${turn.text}`).join('\n\n');
    const reduced = await reduceTranscript(app.router, text, { signal: app.agent.controller?.signal });
    const where = saved.length ? `\n\nAhora estas en la computadora del usuario. Los archivos de esa sesion estan en ${path.relative(app.cwd, target) || 'esta carpeta'}: ${saved.slice(0, 60).join(', ')}${saved.length > 60 ? '…' : ''}` : '\n\nAhora estas en la computadora del usuario.';
    adopt(app, { label: 'bichi work', turns, reduced, extra: where, reply: `Listo, traje la conversacion de bichi work${saved.length ? ` y ${saved.length} archivos` : ''}. ¿Seguimos?`, title: `work: ${item.title}` });
    app.note(`traida de bichi work${saved.length ? ` con ${saved.length} archivos` : ''}`, c.ok);
  });
}
