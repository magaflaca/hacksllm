// bichi code como app de pantalla completa: historial con scroll arriba, entrada abajo entre lineas, sugerencias
// encima de la entrada, raton (rueda, seleccion que copia, clic en links), imagenes, rebobinar y objetivos.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { addProjectAllow, flushState, saveConfig, saveState, VERSION } from './config.mjs';
import { Agent } from './core/agent.mjs';
import { clipboardImage, imagePath, storeImage } from './core/images.mjs';
import { MODE_INFO, MODES } from './core/permissions.mjs';
import { loadCommands } from './core/project.mjs';
import { listSessions, loadSession, newSessionId, saveSession } from './core/sessions.mjs';
import { listSkills } from './core/skills.mjs';
import { displayName } from './providers.mjs';
import { ARG_HINTS, argChoices, COMMANDS, runCommand } from './commands.mjs';
import { runAgy } from './agy-mode.mjs';
import { isAgy } from './core/agy.mjs';
import { codexEffort, codexLabel, isCodex, levelName } from './codex-mode.mjs';
import { listFiles } from './tools/files.mjs';
import { backgroundJobs, killAll, shell as shellTool, stopJob } from './tools/shell.mjs';
import { beetle, logo } from './ui/art.mjs';
import { deniedBlock, notice, READ_TOOLS, readGroupBlock, reasoningBlock, todoLines, toolBlock, toolTitle, userBlock } from './ui/blocks.mjs';
import { diffLines, renderDiff, stats } from './ui/diff.mjs';
import { Editor } from './ui/editor.mjs';
import { FullScreen, parseMouse } from './ui/fullscreen.mjs';
import { createDecoder } from './ui/keys.mjs';
import { renderMarkdown } from './ui/markdown.mjs';
import { bg, bold, c, dim, fg, pad, shimmer, strip, truncate, width, wrap } from './ui/term.mjs';
import { Pet, PET_ROWS, PET_WIDTH } from './ui/pet.mjs';
import { ResumePicker } from './ui/resume.mjs';
import { linksIn, paintSelection, selectedText, Transcript, underlineLink } from './ui/transcript.mjs';
import { box, Field, HistorySearch, Menu } from './ui/widgets.mjs';

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const VERBS = ['Bichiando', 'Rebuscando', 'Tramando', 'Cavilando', 'Zumbando', 'Escarbando', 'Hilando', 'Revoloteando', 'Maquinando', 'Rumiando', 'Tejiendo', 'Cocinando', 'Afinando', 'Husmeando', 'Garabateando'];
const EFFORT = { low: ['◔', 'bajo'], medium: ['◑', 'medio'], high: ['●', 'alto'] };
const DONE_VERBS = ['Bichió', 'Tramó', 'Cocinó', 'Rumió', 'Maquinó', 'Tejió', 'Husmeó', 'Zumbó', 'Escarbó', 'Hiló'];
const MAX_INPUT_ROWS = 10;
const GOAL_ROUNDS = 12;

export class App {
  constructor({ config, state, router, cwd, settings, extraTools, session }) {
    Object.assign(this, { config, state, router, cwd, settings, extraTools });
    this.term = new FullScreen();
    this.term.onResize = () => this.render();
    this.transcript = new Transcript();
    this.editor = new Editor(state.history);
    this._mode = MODES.includes(config.mode) ? config.mode : 'normal';
    this.overlay = null;
    this.suggestions = null;
    this.running = null;
    this.toolItems = new Map();
    this.assistant = null;
    this.thinking = null;
    this.showTodos = true;
    this.follow = true;
    this.top = 0;
    this.viewH = 10;
    this.allLines = [];
    this.selection = null;
    this.pressed = null;
    this.hint = null;
    this.lastEsc = 0;
    this.lastCtrlC = 0;
    this.pendingContext = [];
    this.pendingSteer = [];
    this.pet = new Pet(() => this.schedule());
    this.pet.busy = () => Boolean(this.running || this.overlay);
    this.images = new Map();
    this.imageCount = 0;
    this.tick = 0;
    this.files = [];
    this.session = session ?? { id: newSessionId(), cwd, created: Date.now(), messages: [] };
    this.agent = this.makeAgent();
    this.agent.messages = this.session.messages;
    this.agent.todos = this.session.todos ?? [];
  }

  // El modo (shift+tab, /mode) se recuerda para las siguientes sesiones.
  get mode() {
    return this._mode;
  }

  set mode(value) {
    this._mode = value;
    if (this.config.mode !== value) {
      this.config.mode = value;
      saveConfig(this.config);
    }
  }

  makeAgent() {
    const agent = new Agent({
      config: this.config,
      state: this.state,
      router: this.router,
      cwd: this.cwd,
      settings: this.settings,
      extraTools: this.extraTools,
      mode: () => this.mode,
      ui: this.agentUi(),
    });
    // Clave de cache de la conversacion (bichi-codex retoma lo ya leido en cada peticion).
    agent.cacheKey = () => this.session.id;
    return agent;
  }

  // ---------- arranque y salida ----------

  start() {
    const input = process.stdin;
    input.setRawMode?.(true);
    input.resume();
    input.setEncoding('utf8');
    this.term.enter();
    this.setTitle();
    const decoder = createDecoder((key) => this.onKey(key).catch((error) => this.note(error.message, c.err)));
    input.on('data', (data) => decoder.feed(data));
    process.on('SIGINT', () => this.onKey({ name: 'c', ctrl: true }));
    this.refreshFiles();
    this.ticker = setInterval(() => {
      this.tick++;
      // Con shells en segundo plano, la barra se refresca para mostrar si siguen vivos.
      if (!this.running && this.tick % 20 === 0 && backgroundJobs().length) this.schedule();
      if (this.running) {
        for (const item of this.toolItems.values()) item.update();
        this.thinking?.update();
        if (this.tick % 2 === 0) this.setTitle();
        this.schedule();
      }
    }, 90);
    this.header();
    this.render();
  }

  // Titulo de la ventana: el nombre de la conversacion (o la carpeta) con el bichi delante.
  setTitle() {
    const name = this.session.title || 'bichi code';
    // Trabajando: un punto que va y viene delante del nombre, como el indicador de la app.
    const wave = ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'];
    const busy = this.running ? `${wave[Math.floor(this.tick / 2) % wave.length]} ` : '';
    this.term.title(`👾 ${busy}${name}`);
  }

  rename(title) {
    this.session.title = title;
    this.saveSession();
    this.setTitle();
  }

  // Cabecera: a veces el cartel grande con el logo pixel, a veces la minimalista.
  header() {
    if (this.bigHeader ?? (this.bigHeader = Math.random() < 0.5)) return this.banner();
    this.transcript.add(
      (w) => {
        const pic = beetle('idle');
        const entry = this.router.current ?? this.router.candidates().awake[0] ?? this.router.candidates().list[0];
        const provider = entry?.provider?.label ?? 'sin modelo';
        const home = process.env.HOME ?? process.env.USERPROFILE ?? '\u0000';
        const info = [
          '',
          `${bold('Bichi Code')} ${c.soft(`v${VERSION}`)}`,
          `${c.sky(this.modelLabel())} ${c.soft(`· ${provider}`)}`,
          c.soft(this.cwd.replace(home, '~')),
          '',
          dim('/help comandos · @ archivos · alt+v imagen · shift+tab modos'),
        ];
        if (w < 50) return info.filter(Boolean);
        const lines = [];
        for (let i = 0; i < Math.max(pic.length, info.length); i++) lines.push(`  ${pad(pic[i] ?? '', 16)}  ${info[i] ?? ''}`);
        return lines;
      },
      { gap: 0 },
    );
  }

  // El cartel grande: bichi contento y el logo BICHI CODE en una caja azul.
  banner() {
    this.transcript.add(
      (w) => {
        const pic = beetle('happy');
        const home = process.env.HOME ?? process.env.USERPROFILE ?? '\u0000';
        const info = [
          ...logo('BICHI CODE'),
          `${c.soft('v')}${c.sky(VERSION)} ${c.soft('·')} ${c.ice('tu bicho programador')}`,
          '',
          `${c.soft('modelo ')} ${c.sky(this.modelLabel())}${this.config.model === 'auto' ? c.soft('  (cambia solo si uno se agota)') : ''}`,
          `${c.soft('carpeta')} ${this.cwd.replace(home, '~')}`,
        ];
        const hints = `  ${c.sky('/')} ${c.soft('comandos')}  ${c.sky('@')} ${c.soft('archivos')}  ${c.sky('!')} ${c.soft('shell')}  ${c.sky('alt+v')} ${c.soft('imagen')}  ${c.sky('shift+tab')} ${c.soft('modos')}`;
        if (w < 72) return [...info.slice(6), '', hints];
        const lines = [];
        for (let i = 0; i < Math.max(pic.length, info.length); i++) lines.push(`${pad(pic[i] ?? '', 18)}  ${info[i] ?? ''}`);
        const inner = Math.min(w - 1, Math.max(...lines.map(width)) + 6);
        return [...box(lines, inner, { color: c.deep, padX: 2 }), hints];
      },
      { gap: 0 },
    );
  }

  async exit(code = 0) {
    // Con shells en segundo plano, se pregunta: pueden seguir vivos sin bichi (como servidores de desarrollo).
    const running = backgroundJobs().filter((job) => job.exit === null);
    let kept = 0;
    if (running.length && !this.exiting) {
      this.exiting = true;
      const choice = await this.choose({
        title: 'antes de salir',
        body: [`${running.length === 1 ? 'hay 1 shell corriendo' : `hay ${running.length} shells corriendo`} en segundo plano:`, ...running.map((job) => c.soft(`  shell ${job.number} · ${truncate(job.command, 70)}`))],
        options: [
          { label: 'dejarlos corriendo y salir', hint: 'siguen vivos; los veras al volver a abrir bichi', value: 'keep' },
          { label: 'detenerlos y salir', value: 'stop' },
          { label: 'no salir', value: null, hint: 'esc' },
        ],
        escape: null,
      });
      this.exiting = false;
      if (!choice) return this.render();
      if (choice === 'stop') killAll();
      else kept = running.length;
    }
    clearInterval(this.ticker);
    this.saveSession();
    flushState(this.state);
    this.term.leave();
    const total = this.agent.usage.prompt + this.agent.usage.completion;
    const lines = [`${c.brand('●')} ${c.ice('hasta luego')}${total ? c.soft(`  · ${formatTokens(total)} tokens en esta sesion`) : ''}`];
    if (kept) lines.push(c.soft(`  ${kept === 1 ? 'queda 1 shell corriendo' : `quedan ${kept} shells corriendo`} en segundo plano (/jobs para verlos)`));
    if (this.session.messages.length) lines.push(c.soft(`  para seguir: bichi -r ${this.session.id}`));
    process.stdout.write(`${lines.join('\n')}\n`);
    process.stdin.setRawMode?.(false);
    process.exit(code);
  }

  saveSession() {
    this.session.messages = this.agent.messages;
    this.session.todos = this.agent.todos;
    this.session.model = this.config.model;
    saveSession(this.session);
  }

  async refreshFiles() {
    try {
      this.files = await listFiles(this.cwd);
    } catch {
      this.files = [];
    }
  }

  // ---------- historial ----------

  add(render, options) {
    const item = this.transcript.add(render, options);
    this.schedule();
    return item;
  }

  // Texto suelto en el historial (lo usan los comandos).
  print(text) {
    const value = String(text ?? '');
    this.add(() => value.replace(/^\n+|\n+$/g, '').split('\n'), { gap: value.startsWith('\n') || value.startsWith('\r') ? 1 : 0 });
  }

  space() {}

  // Mensaje del usuario (o comando) con fondo sombreado de lado a lado. `pending`: mandado mientras bichi
  // trabajaba y aun sin leer; tiene otro tono hasta que entra en el siguiente paso.
  addUser(text, { pending = false } = {}) {
    const item = this.add((w) => {
      const shade = bg(item.pending ? '#3b2f63' : '#262c4d');
      const lines = userBlock(text, w - 2).map(highlightTags);
      if (item.pending) lines.push(`  ${dim(isAgy(this.config.model) ? 'en cola · va en cuanto acabe este turno' : 'en cola · se lee en el siguiente paso')}`);
      return lines.map((line) => shade(pad(line, w - 1)));
    });
    item.user = true;
    item.pending = pending;
    return item;
  }

  note(text, color = c.soft) {
    this.add(() => [notice(text, color)], { gap: 0 });
  }

  // Pasar a trabajar en otra carpeta (el modo agy la crea para conversaciones sin proyecto).
  moveTo(dir) {
    process.chdir(dir);
    this.cwd = dir;
    this.agent.cwd = dir;
    this.session.cwd = dir;
    this.files = [];
    this.refreshFiles();
    this.note(`trabajando en ${dir}`, c.ok);
  }

  clearConversation() {
    this.saveSession();
    this.session = { id: newSessionId(), cwd: this.cwd, created: Date.now(), messages: [] };
    this.agent.messages = this.session.messages;
    this.agent.todos = [];
    this.agent.turns = [];
    this.agent.goal = null;
    this.agent.usage = { prompt: 0, completion: 0, lastPrompt: 0 };
    this.transcript.clear();
    this.header();
    this.follow = true;
    this.render();
  }

  // Rehace el historial desde los mensajes (al retomar, importar o rebobinar).
  replay() {
    this.transcript.clear();
    this.header();
    const results = new Map(this.agent.messages.filter((message) => message.role === 'tool').map((message) => [message.tool_call_id, message.content]));
    const tools = this.agent.tools();
    const shown = this.session.shown;
    if (shown) this.replayShown(shown);
    const isRetryNote = (message) => message?.role === 'user' && typeof message.content === 'string' && message.content.startsWith('(nota del sistema) Tu ultima respuesta parece');
    for (const [index, message] of this.agent.messages.entries()) {
      // Una llamada mal escrita y la nota que pidio repetirla no se ensenan.
      if (isRetryNote(message) || isRetryNote(this.agent.messages[index + 1])) continue;
      if (message.role === 'user' && typeof message.content === 'string') {
        const text = stripAttachments(message.content);
        if (shown && text.startsWith('(Conversacion importada'))
          this.add(() => [notice(`hasta aqui, la conversacion de ${shown.from}${shown.summarized ? ' · bichi la lee resumida para ahorrar contexto' : ''}`, c.plum)]);
        else if (/^\((Esta conversacion se resumio|Se recorto|Conversacion importada)/.test(text)) this.add(() => [notice('conversacion anterior resumida', c.plum)]);
        else this.addUser(text.replace(/^\((mensaje del usuario|sigue con el objetivo|nota)[^)]*\)\n?/, ''));
      } else if (message.role === 'assistant') {
        if (message.content && message.content !== 'Entendido, sigo desde aqui.') {
          const text = message.content;
          this.add((w) => assistantLines(text, w));
        }
        for (const call of message.tool_calls ?? []) {
          const result = String(results.get(call.id) ?? '');
          let input = {};
          try {
            input = JSON.parse(call.function.arguments || '{}');
          } catch {
            /* argumentos rotos */
          }
          const tool = tools.find((item) => item.name === call.function.name);
          const label = tool ? safe(() => tool.label(input, { cwd: this.cwd })) : { title: call.function.name, arg: '' };
          this.addReplayedTool(call.function.name, label, input, result);
        }
      }
      const stamp = this.session.stamps?.[index];
      if (stamp) this.add(() => stampLine(stamp));
    }
    this.follow = true;
    this.render();
  }

  // La conversacion original de algo traido de fuera (/tp, /import), tal como se vio alli. Solo es para leer:
  // el modelo trabaja con la version reducida.
  replayShown(shown) {
    if (shown.cut) this.add(() => [notice(`conversacion de ${shown.from} · los mensajes mas viejos no se guardaron`, c.plum)]);
    for (const turn of shown.turns) {
      if (turn.role === 'user') {
        this.addUser(turn.text);
        continue;
      }
      const tools = turn.tools ?? [];
      if (turn.text) this.add((w) => assistantLines(turn.text, w));
      if (tools.length) this.add((w) => tools.map((tool, i) => `  ${c.soft(i ? ' ' : '╰')}  ${dim(truncate(tool, w - 8))}`), { gap: turn.text ? 0 : 1 });
    }
  }

  // Herramienta de una conversacion retomada: plegada como siempre y con clic se abre. Las ediciones reconstruyen
  // su diff con los argumentos guardados (texto viejo y nuevo); el resto muestra su resultado.
  addReplayedTool(name, label, input, result) {
    const failed = result.startsWith('error');
    const first = result.split('\n').find(Boolean) ?? '';
    let ops = null;
    if (!failed && name === 'edit' && typeof input.old_string === 'string') ops = diffLines(input.old_string, String(input.new_string ?? ''));
    if (!failed && name === 'write' && typeof input.content === 'string') ops = diffLines('', input.content);
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const summary = ops ? `${plural(stats(ops).added, 'linea nueva', 'lineas nuevas')}, ${plural(stats(ops).removed, 'quitada', 'quitadas')}` : first;
    const item = this.add((w) => {
      const head = toolTitle({ label, tool: { name } }, failed ? 'error' : 'done');
      const open = this.config.verbose || item.expanded;
      if (!open) return [head, `  ${c.soft('╰')}  ${c.soft(truncate(summary, w - 24))} ${dim('· clic para ver')}`];
      if (ops) return [head, `  ${c.soft('╰')}  ${c.soft(summary)}`, ...renderDiff(ops, { columns: w - 6, maxLines: 2000 }).map((line) => `     ${line}`)];
      return [head, ...result.split('\n').slice(0, 2000).map((line, i) => `  ${i ? ' ' : c.soft('╰')}  ${dim(line)}`)];
    });
    item.toggle = () => (item.expanded = !item.expanded);
  }

  // ---------- dibujo ----------

  schedule() {
    if (!this.pending) this.pending = setTimeout(() => this.render(), 33);
  }

  render() {
    clearTimeout(this.pending);
    this.pending = null;
    if (!this.term.active) return;
    const { width: W, height: H } = this.term.size();
    if (this.picker) {
      const frame = this.picker.render(W, H);
      return this.term.draw(frame.lines, frame.cursor);
    }
    const bottom = this.bottom(W, H);
    const viewH = Math.max(1, H - bottom.lines.length);
    const all = this.transcript.lines(W);
    const maxTop = Math.max(0, all.length - viewH);
    this.top = this.follow ? maxTop : Math.min(this.top, maxTop);
    if (this.top >= maxTop) this.follow = true;
    this.viewH = viewH;
    this.allLines = all;
    const hovered = this.hoverLink;
    const view = all.slice(this.top, this.top + viewH).map((line, i) => {
      const painted = hovered?.line === this.top + i ? underlineLink(line, hovered.k) : line;
      return paintSelection(painted, this.top + i, this.selection);
    });
    while (view.length < viewH) view.push('');
    // Tu pregunta queda fija arriba mientras lees su respuesta; clic para volver a ella.
    this.sticky = null;
    const owner = (this.transcript.ranges ?? []).filter((range) => range.item.user && range.start < this.top).at(-1);
    if (owner && viewH > 4) {
      const text = strip(all[owner.start] ?? '').replace(/^›\s*/, '').trim();
      this.sticky = owner.start;
      view[0] = bg('#2a3157')(pad(`${c.brand('❯')} ${c.ice(truncate(text, W - 6))}`, W - 1));
    }
    const cursor = bottom.cursor ? { row: viewH + bottom.cursor.row, col: bottom.cursor.col } : null;
    this.term.draw([...view, ...bottom.lines], cursor);
  }

  modelLabel() {
    if (isAgy(this.config.model)) return 'bichi-agy';
    if (isCodex(this.config.model)) return codexLabel(this);
    const entry = this.router.current ?? this.router.candidates().awake[0] ?? this.router.candidates().list[0];
    if (this.config.model === 'auto') return entry ? `auto · ${displayName(this.config, entry)}` : 'auto';
    return entry ? displayName(this.config, entry) : this.config.model;
  }

  // Parte de abajo: trabajo en curso, sugerencias, entrada entre lineas y barra de estado.
  bottom(W, H) {
    const lines = [];
    let cursor = null;
    // Boton para volver al final cuando subiste por el historial (clic o ctrl+fin).
    this.clickRows = {};
    if (!this.follow) {
      const label = ' ↓ ir al final (ctrl+fin) ';
      const left = Math.max(0, Math.floor((W - width(label)) / 2));
      this.clickRows.jump = { row: lines.length, from: left, to: left + width(label) };
      lines.push(' '.repeat(left) + bg('#3d74c4')(fg('#ffffff')(label)));
    }
    if (this.running && !this.overlay) {
      lines.push('');
      lines.push(this.spinnerLine());
      if (this.showTodos && this.agent.todos.some((item) => item.status !== 'completed')) {
        todoLines(this.agent.todos).forEach((line, i) => lines.push(`  ${i ? ' ' : c.soft('╰')}  ${line}`));
      }
    }
    const rule = c.soft('─'.repeat(W - 1));
    if (this.overlay) {
      const rendered = this.overlay.render(W);
      const block = Array.isArray(rendered) ? rendered : rendered.lines;
      const room = Math.max(4, H - 4 - lines.length);
      const cut = Math.max(0, block.length - room);
      lines.push('');
      if (!Array.isArray(rendered)) cursor = { row: lines.length + rendered.cursor.row - cut, col: rendered.cursor.col };
      this.clickRows.overlay = lines.length - cut; // fila 0 de la caja del dialogo
      lines.push(...block.slice(cut));
    } else {
      this.clickRows.suggestions = lines.length;
      lines.push(...this.suggestionLines(W));
      const [glyph, effort] = isCodex(this.config.model) ? [EFFORT[codexEffort(this)]?.[0] ?? '●', levelName(codexEffort(this))] : (EFFORT[this.config.effort] ?? EFFORT.medium);
      const right = `${c.sky(this.modelLabel())} ${c.soft('·')} ${c.soft(`${glyph} ${effort} · /effort`)}`;
      const rightStart = Math.max(0, W - 2 - width(right));
      // La mascota va sobre la linea de la entrada, sin pisar el texto de la derecha.
      const pet = this.pet?.sprite(rightStart - PET_WIDTH - 8);
      if (pet && pet.x + PET_WIDTH + 8 <= rightStart) {
        // Las lineas de arriba van solas (la barra crece, no tapa nada), la penultima comparte fila con el modelo y
        // la ultima (las patitas) va sobre la regla de la entrada.
        this.clickRows.pet = lines.length;
        const top = pet.lines.slice(0, -2);
        top.forEach((line, i) => lines.push(`${' '.repeat(pet.x)}${line}${i === 0 ? ` ${pet.extra}` : ''}`));
        const middle = `${' '.repeat(pet.x)}${pet.lines.at(-2)}`;
        lines.push(middle + ' '.repeat(Math.max(1, rightStart - width(middle))) + right);
        const feet = pet.lines.at(-1).replace(/ /g, c.soft('─'));
        lines.push(`${c.soft('─'.repeat(pet.x))}${feet}${c.soft('─'.repeat(Math.max(0, W - 1 - pet.x - PET_WIDTH)))}`);
      } else {
        this.clickRows.pet = undefined;
        lines.push(' '.repeat(rightStart) + right);
        lines.push(rule);
      }
      const input = this.inputLines(W);
      this.clickRows.input = { row: lines.length, count: input.lines.length, shift: input.shift ?? 0, inner: W - 4 };
      cursor = { row: lines.length + input.cursor.row, col: input.cursor.col };
      lines.push(...input.lines);
      lines.push(rule);
    }
    this.clickRows.footer = lines.length;
    lines.push(this.footer(W));
    return { lines, cursor };
  }

  spinnerLine() {
    const seconds = Math.floor((Date.now() - this.running.started) / 1000);
    const tokens = this.running.chars ? ` · ↓ ${formatTokens(Math.round(this.running.chars / 3.6))} tokens` : '';
    const what = this.thinking ? ' · pensando' : '';
    return `${c.brand(SPIN[this.tick % SPIN.length])} ${shimmer(`${this.running.verb}…`, this.tick)} ${c.soft(`(${clock(seconds)}${tokens}${what} · esc para interrumpir)`)}`;
  }

  inputLines(W) {
    const inner = W - 4;
    const { rows, cursor, starts } = this.editor.layout(inner);
    const text = this.editor.text;
    const range = this.editor.selection();
    // Fila con la parte seleccionada en azul (como al seleccionar en la terminal).
    const paint = (row, index) => {
      const from = range ? Math.max(range[0], starts[index]) - starts[index] : -1;
      const to = range ? Math.min(range[1], starts[index] + row.length) - starts[index] : -1;
      if (to <= from || from < 0) return highlightTags(row);
      return row.slice(0, from) + bg('#3d74c4')(fg('#ffffff')(row.slice(from, to))) + row.slice(to);
    };
    const prompt = text.startsWith('!') ? c.warn('!') : text.startsWith('#') ? c.plum('#') : this.running ? c.soft('❯') : c.brand('❯');
    if (!text) {
      const placeholder = this.running ? 'escribe para redirigir a bichi sin parar el trabajo' : 'Prueba "explicame este proyecto" o "arregla los tests"';
      return { lines: [`${prompt} ${dim(placeholder)}`], cursor: { row: 0, col: 2 } };
    }
    const shift = rows.length > MAX_INPUT_ROWS ? Math.max(0, Math.min(cursor.row - MAX_INPUT_ROWS + 1, rows.length - MAX_INPUT_ROWS)) : 0;
    const lines = rows.slice(shift, shift + MAX_INPUT_ROWS).map((row, i) => `${i === 0 && shift === 0 ? prompt : ' '} ${paint(row, i + shift)}`);
    // Sintaxis del comando en gris mientras falta el argumento: "/model [modelo]".
    const command = /^\/([\w-]+) ?$/.exec(text);
    if (command && ARG_HINTS[command[1]] && lines.length === 1) lines[0] += `${text.endsWith(' ') ? '' : ' '}${dim(ARG_HINTS[command[1]])}`;
    return { lines, shift, cursor: { row: cursor.row - shift, col: 2 + cursor.col } };
  }

  footer(W) {
    const info = MODE_INFO[this.mode];
    let left;
    if (this.hint && Date.now() < this.hint.until) left = c.soft(`  ${this.hint.text}`);
    else if (this.editor.text.startsWith('!')) left = c.warn('  ! modo shell: enter ejecuta el comando aqui mismo');
    else if (this.editor.text.startsWith('#')) left = c.plum('  # enter guarda esto en la memoria');
    else if (this.mode === 'normal') left = c.soft('  ? atajos · shift+tab para cambiar de modo');
    else left = `  ${c[info.color](`▸▸ ${info.label}`)} ${c.soft('(shift+tab para cambiar)')}`;
    const parts = [];
    // Shells en segundo plano (servidores, watchers): clic para ver lo que hacen o detenerlos.
    const alive = backgroundJobs().filter((job) => job.exit === null).length;
    const shells = alive ? `◉ ${alive} ${alive === 1 ? 'shell' : 'shells'} activo${alive === 1 ? '' : 's'}` : '';
    if (shells) parts.push(c.ok(shells));
    if (this.agent.subagents) parts.push(c.plum(`← ${this.agent.subagents} ${this.agent.subagents === 1 ? 'agente' : 'agentes'}`));
    if (this.agent.goal && !this.agent.goal.done) parts.push(c.ok(`◎ objetivo · ronda ${this.agent.goal.rounds + 1}`));
    const ctx = Math.min(100, Math.round((this.agent.contextUsed() / this.agent.contextLimit()) * 100));
    if (ctx >= 30) parts.push(ctx >= 65 ? c.warn(`contexto ${ctx}%`) : c.soft(`contexto ${ctx}%`));
    const right = parts.join(c.soft(' · '));
    const gap = W - 2 - width(left) - width(right);
    if (gap <= 1) return left;
    if (shells) this.clickRows.shells = { from: width(left) + gap, to: width(left) + gap + width(shells) };
    return `${left}${' '.repeat(gap)}${right}`;
  }

  // Lista de shells en segundo plano: elegir uno para ver su salida o detenerlo.
  async jobsMenu() {
    const jobs = backgroundJobs();
    if (!jobs.length) return this.flash('no hay shells en segundo plano');
    const id = await this.choose({
      title: 'shells en segundo plano',
      options: jobs.map((job) => ({
        label: `shell ${job.number} · ${truncate(job.command, 60)}`,
        hint: job.exit === null ? `corriendo hace ${clock(Math.round((Date.now() - job.started) / 1000))}` : `termino (codigo ${job.exit})`,
        value: job.id,
      })),
      escape: null,
    });
    if (!id) return;
    const job = jobs.find((item) => item.id === id);
    const action = await this.choose({
      title: `shell ${job.number}`,
      body: [c.ice(job.command), '', ...job.output.trimEnd().split('\n').slice(-12).map((line) => dim(strip(line)))],
      options: [
        { label: 'ver la salida en la conversacion', value: 'show' },
        ...(job.exit === null ? [{ label: 'detenerlo', value: 'stop' }] : []),
        { label: 'volver', value: null, hint: 'esc' },
      ],
      escape: null,
    });
    if (action === 'stop') {
      stopJob(id);
      this.note(`shell ${job.number} detenido`, c.ok);
    } else if (action === 'show') {
      const lines = job.output.trimEnd().split('\n').slice(-300);
      this.add(() => [`${c.ok('●')} ${bold(`Shell ${job.number}`)} ${c.soft(job.command)}`, ...lines.map((line) => `    ${dim(strip(line))}`)]);
    }
    this.render();
  }

  suggestionLines(W) {
    const list = this.suggestions;
    if (!list?.items.length) return [];
    const nameWidth = Math.min(32, Math.max(...list.items.map((item) => width(item.label))) + 3);
    const descWidth = W - nameWidth - 8;
    const out = [];
    this.suggestionMap = []; // fila -> sugerencia, para los clics
    list.items.forEach((item, i) => {
      const active = i === list.index;
      const name = pad(markMatch(item.label, list.query, active), nameWidth);
      const all = item.hint && descWidth > 12 ? wrap(item.hint, descWidth) : [''];
      const desc = all.slice(0, 2);
      if (all.length > 2) desc[1] = truncate(`${desc[1]} …`, descWidth);
      desc.forEach((part, k) => {
        out.push(`  ${k === 0 && active ? c.brand('❯') : ' '} ${k === 0 ? name : ' '.repeat(nameWidth)}${active ? c.sky(part) : c.soft(part)}`);
        this.suggestionMap.push(i);
      });
    });
    return out;
  }

  // ---------- completado de /comandos y @archivos ----------

  updateSuggestions() {
    // Argumento de un comando ("/model bi", "/bichito "): se sugieren sus opciones.
    const arg = /^\/([\w-]+) (\S*)$/.exec(this.editor.text);
    if (arg && this.editor.cursor === this.editor.text.length) {
      const typed = arg[2].toLowerCase();
      const items = argChoices(this, arg[1])
        .filter((choice) => choice.value.toLowerCase().startsWith(typed) && choice.value.toLowerCase() !== typed)
        .slice(0, 8)
        .map((choice) => ({ label: choice.value, hint: choice.hint, value: `/${arg[1]} ${choice.value}`, whole: true }));
      this.suggestions = items.length ? { items, index: Math.min(this.suggestions?.index ?? 0, items.length - 1), query: typed } : null;
      return;
    }
    const token = this.editor.token();
    if (!token) return (this.suggestions = null);
    const query = token.text.slice(1);
    let items = [];
    if (token.text.startsWith('/') && token.atStart) {
      const lower = query.toLowerCase();
      const custom = loadCommands(this.cwd).map((command) => ({ name: command.name, description: command.description }));
      const skills = listSkills(this.cwd).map((skill) => ({ name: skill.name, description: `(skill) ${skill.description}` }));
      items = [...COMMANDS.filter((command) => !command.hidden), ...custom, ...skills]
        .filter((command) => command.name.startsWith(lower) || (lower.length > 1 && command.name.includes(lower)))
        .sort((a, b) => b.name.startsWith(lower) - a.name.startsWith(lower))
        .slice(0, 8)
        .map((command) => ({ label: `/${command.name}`, hint: command.description, value: `/${command.name} ` }));
    } else if (token.text.startsWith('@')) items = this.pathSuggestions(query);
    this.suggestions = items.length ? { items, index: Math.min(this.suggestions?.index ?? 0, items.length - 1), token, query: query.toLowerCase() } : null;
  }

  // Carpetas y archivos como en un explorador; sin barra, ademas busqueda en todo el proyecto.
  pathSuggestions(query) {
    const normalized = query.replace(/\\/g, '/');
    const slash = normalized.lastIndexOf('/');
    const dir = slash >= 0 ? normalized.slice(0, slash + 1) : '';
    const rest = normalized.slice(slash + 1).toLowerCase();
    const children = new Map();
    for (const file of this.files) {
      if (!file.startsWith(dir)) continue;
      const tail = file.slice(dir.length);
      const cut = tail.indexOf('/');
      const name = cut >= 0 ? tail.slice(0, cut + 1) : tail;
      const lower = name.toLowerCase();
      if (rest && !lower.startsWith(rest) && !(rest.length > 1 && lower.includes(rest))) continue;
      children.set(name, cut >= 0);
    }
    const entries = [...children.entries()].sort(([a, dirA], [b, dirB]) => dirB - dirA || a.localeCompare(b)).map(([name, isDir]) => ({ path: dir + name, isDir }));
    if (!dir && rest.length > 1 && entries.length < 8) {
      const seen = new Set(entries.map((entry) => entry.path));
      for (const file of this.files) {
        if (entries.length >= 8) break;
        if (!seen.has(file) && file.toLowerCase().includes(rest)) entries.push({ path: file, isDir: false });
      }
    }
    return entries.slice(0, 8).map((entry) => ({ label: `+ ${entry.path}`, value: entry.isDir ? `@${entry.path}` : `@${entry.path} ` }));
  }

  acceptSuggestion() {
    const list = this.suggestions;
    const item = list.items[list.index];
    if (item.whole) this.editor.set(item.value);
    else this.editor.replaceToken(this.editor.token() ?? list.token, item.value);
    this.suggestions = null;
    return item;
  }

  // ---------- raton ----------

  onMouse(event) {
    if (!event) return;
    if (this.picker) {
      const index = this.picker.at(event.y);
      if (event.type === 'wheelup') this.picker.key({ name: 'up' });
      else if (event.type === 'wheeldown') this.picker.key({ name: 'down' });
      else if (index >= 0 && event.type === 'move') this.picker.index = index;
      else if (index >= 0 && event.type === 'press' && event.button === 0) {
        this.picker.index = index;
        this.picker.key({ name: 'enter' });
      }
      return this.render();
    }
    const inView = event.y < this.viewH;
    // Sobre una lista (sugerencias o menu), el raton elige: pasar por encima selecciona y la rueda la recorre.
    if (event.type === 'move') {
      if (this.pressed) return null;
      this.hoverOnLink(inView ? this.top + event.y : -1, event.x);
      return this.hover(event.y - this.viewH);
    }
    if (event.type === 'wheelup' || event.type === 'wheeldown') {
      const list = !inView && (this.overlay?.options ? this.overlay : this.suggestions);
      if (list?.options ?? list?.items) {
        const count = (list.options ?? list.items).length;
        list.index = (list.index + (event.type === 'wheelup' ? -1 : 1) + count) % count;
        return this.render();
      }
      return this.scroll(event.type === 'wheelup' ? -3 : 3);
    }
    // Clic derecho: pega lo que haya en el portapapeles (la terminal no puede, porque bichi usa el raton).
    // Con algo seleccionado (ya copiado), el clic derecho solo quita la seleccion; el siguiente pega.
    if (event.type === 'press' && event.button === 2) {
      if (this.selection || this.editor.selection()) {
        this.selection = null;
        this.editor.anchor = null;
        return this.render();
      }
      return this.pasteClipboard();
    }
    if (event.type === 'press' && event.button === 0) {
      this.selection = null;
      this.editor.anchor = null;
      if (event.y === 0 && this.sticky !== null) {
        this.pressed = null;
        return this.scroll(this.sticky - this.top);
      }
      this.pressed = inView ? { line: this.top + event.y, col: event.x } : null;
      if (!inView) this.clickBottom(event.y - this.viewH, event.x);
      return this.render();
    }
    // Arrastrar dentro de la entrada selecciona texto; al soltar se copia.
    if (event.type === 'drag' && this.inputDrag && this.clickRows?.input) {
      this.editor.cursor = this.inputPosition(event.y - this.viewH, event.x);
      return this.render();
    }
    if (event.type === 'release' && this.inputDrag) {
      this.inputDrag = false;
      const text = this.editor.selectedText();
      if (!text) this.editor.anchor = null;
      else {
        this.term.copy(text);
        copyNative(text);
        this.flash('copiado · escribe para reemplazarlo');
      }
      return this.render();
    }
    if (event.type === 'drag' && this.pressed) {
      const end = { line: this.top + Math.min(event.y, this.viewH - 1), col: event.x };
      // Con el seguimiento de movimiento la terminal manda "arrastres" sin moverse: eso sigue siendo un clic.
      if (!this.selection && end.line === this.pressed.line && Math.abs(end.col - this.pressed.col) < 2) return;
      if (event.y >= this.viewH) this.scroll(1);
      if (event.y <= 0) this.scroll(-1);
      this.selection = { start: this.pressed, end };
      return this.render();
    }
    if (event.type === 'release' && this.pressed) {
      const start = this.pressed;
      this.pressed = null;
      if (this.selection) {
        const text = selectedText(this.allLines, this.selection);
        if (text.trim()) {
          this.term.copy(text);
          copyNative(text);
          this.flash('copiado al portapapeles');
        }
        return this.render();
      }
      const line = this.allLines[start.line] ?? '';
      const link = linksIn(line).find((item) => start.col >= item.from && start.col < item.to);
      if (link) {
        openTarget(link.url);
        return this.flash(`abriendo ${link.url.replace(/^file:\/\/\/?/, '')}`);
      }
      // Clic en un bloque plegable (razonamiento, diff o salida larga, lecturas agrupadas): se abre o se pliega.
      const item = this.transcript.itemAt(start.line);
      if (item?.toggle) {
        item.toggle();
        item.update();
        this.render();
      }
    }
  }

  // Indice del texto de la entrada bajo una fila/columna de la parte de abajo (fuera de la caja, se ajusta al borde).
  inputPosition(row, col) {
    const input = this.clickRows.input;
    const inside = Math.max(0, Math.min(input.count - 1, row - input.row));
    if (row < input.row) return input.shift ? this.editor.positionAt(input.inner, input.shift, 0) : 0;
    if (row >= input.row + input.count) return this.editor.positionAt(input.inner, inside + input.shift, Infinity);
    return this.editor.positionAt(input.inner, inside + input.shift, Math.max(0, col - 2));
  }

  // Clics en la parte de abajo: el boton de ir al final y las sugerencias.
  clickBottom(row, col) {
    const jump = this.clickRows?.jump;
    if (jump && row === jump.row && col >= jump.from && col < jump.to) return this.jumpToEnd();
    const petRow = this.clickRows?.pet;
    if (petRow !== undefined && row >= petRow && row < petRow + PET_ROWS && this.pet.hit(col)) return this.pet.leave();
    const shells = this.clickRows?.shells;
    if (shells && row === this.clickRows.footer && col >= shells.from && col < shells.to) return this.jobsMenu();
    if (this.overlay?.click && this.clickRows.overlay !== undefined) return this.overlay.click(row - this.clickRows.overlay);
    // Clic en la entrada: el cursor va ahi.
    const input = this.clickRows?.input;
    if (input && !this.overlay && row >= input.row && row < input.row + input.count && this.editor.text) {
      this.editor.cursor = this.inputPosition(row, col);
      this.editor.anchor = this.editor.cursor;
      this.inputDrag = true;
      this.updateSuggestions();
      return this.render();
    }
    const list = this.suggestions;
    if (list && this.clickRows.suggestions !== undefined) {
      const index = this.suggestionMap?.[row - this.clickRows.suggestions];
      if (index !== undefined) {
        list.index = index;
        const item = this.acceptSuggestion();
        if (item.label.startsWith('/') || item.whole) return this.submit();
        this.updateSuggestions();
      }
    }
  }

  // `bichi --resume`: la pantalla completa para elegir que conversacion retomar.
  async pickResume() {
    this.picker = new ResumePicker({ here: listSessions(this.cwd), all: listSessions(), cwd: this.cwd });
    this.term.prev = [];
    this.term.title('👾 bichi · retomar');
    this.render();
    const id = await this.picker.promise;
    this.picker = null;
    this.term.prev = [];
    if (id) (await import('./commands.mjs')).resumeInto(this, loadSession(id));
    this.setTitle();
    this.render();
  }

  // Los links no van subrayados: se subrayan solo mientras el raton esta encima.
  hoverOnLink(line, col) {
    const links = line >= 0 ? linksIn(this.allLines?.[line] ?? '') : [];
    const k = links.findIndex((link) => col >= link.from && col < link.to);
    const next = k >= 0 ? { line, k } : null;
    if (next?.line === this.hoverLink?.line && next?.k === this.hoverLink?.k) return;
    this.hoverLink = next;
    this.render();
  }

  // Raton encima de la parte de abajo: marca la sugerencia u opcion de menu que haya en esa fila.
  hover(row) {
    if (row < 0) return;
    if (this.overlay?.optionRows && this.clickRows.overlay !== undefined) {
      const index = this.overlay.optionRows.indexOf(row - this.clickRows.overlay);
      if (index >= 0 && index !== this.overlay.index) {
        this.overlay.index = index;
        this.render();
      }
      return;
    }
    const index = this.suggestions && this.suggestionMap?.[row - this.clickRows.suggestions];
    if (index !== undefined && index !== null && index !== false && index !== this.suggestions.index) {
      this.suggestions.index = index;
      this.render();
    }
  }

  async pasteClipboard() {
    const text = await readClipboard();
    if (!text) return this.flash('el portapapeles esta vacio (alt+v para imagenes)');
    if (this.overlay?.key) this.overlay.key({ name: 'paste', paste: text });
    else {
      this.paste(text);
      this.updateSuggestions();
    }
    this.render();
  }

  jumpToEnd() {
    this.follow = true;
    this.render();
  }

  scroll(delta) {
    const maxTop = Math.max(0, this.allLines.length - this.viewH);
    this.top = Math.max(0, Math.min(maxTop, this.top + delta));
    this.follow = this.top >= maxTop;
    this.render();
  }

  flash(text, ms = 2500) {
    this.hint = { text, until: Date.now() + ms };
    setTimeout(() => this.schedule(), ms + 10);
    this.schedule();
  }

  // ---------- teclas ----------

  async onKey(key) {
    if (key.name === 'mouse') {
      this.pet.lastInput = Date.now();
      return this.onMouse(parseMouse(key.sequence));
    }
    this.pet.input();
    this.selection = null;
    if (this.picker) {
      this.picker.key(key);
      return this.render();
    }
    if (key.name === 'pageup') return this.scroll(-(this.viewH - 2));
    if (key.name === 'pagedown') return this.scroll(this.viewH - 2);
    if (key.ctrl && key.name === 'end') return this.jumpToEnd();
    if (key.ctrl && key.name === 'home') return this.scroll(-this.allLines.length);
    if (this.overlay) {
      this.overlay.key(key);
      return this.render();
    }
    const editor = this.editor;
    const name = key.name;

    // Con texto seleccionado en la entrada: borrar lo quita, escribir lo reemplaza, shift+flechas lo amplian,
    // ctrl+c lo copia y cualquier otro movimiento lo suelta.
    if (editor.selection()) {
      if (name === 'backspace' || name === 'delete') {
        editor.deleteSelection();
        this.updateSuggestions();
        return this.render();
      }
      if (key.ctrl && name === 'c') {
        const text = editor.selectedText();
        this.term.copy(text);
        copyNative(text);
        editor.anchor = null;
        this.flash('copiado');
        return this.render();
      }
      const typing = name === 'paste' || name === 'enter' || (key.text && !key.ctrl && !key.meta);
      if (!typing && !(key.shift && ['left', 'right', 'home', 'end', 'up', 'down'].includes(name))) editor.anchor = null;
    }
    if (key.shift && ['left', 'right', 'home', 'end'].includes(name)) {
      editor.anchor ??= editor.cursor;
      if (name === 'left') key.ctrl ? editor.wordLeft() : editor.left();
      else if (name === 'right') key.ctrl ? editor.wordRight() : editor.right();
      else if (name === 'home') editor.home();
      else editor.end();
      return this.render();
    }

    if (key.ctrl && name === 'c') {
      if (this.running) return this.interrupt();
      if (editor.text) {
        editor.clear();
        this.suggestions = null;
        return this.render();
      }
      if (Date.now() - this.lastCtrlC < 1500) return this.exit();
      this.lastCtrlC = Date.now();
      return this.flash('pulsa ctrl+c otra vez para salir', 1500);
    }
    if (key.ctrl && name === 'd' && !editor.text) return this.exit();
    if (name === 'escape') {
      if (this.suggestions) {
        this.suggestions = null;
        return this.render();
      }
      if (this.running) return this.interrupt();
      const double = Date.now() - this.lastEsc < 600;
      this.lastEsc = Date.now();
      if (double) {
        if (editor.text) editor.clear();
        else return this.exit();
      } else this.flash(editor.text ? 'esc otra vez para borrar' : 'esc otra vez para salir de bichi', 600);
      return this.render();
    }
    if (name === 'tab' && key.shift) {
      this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
      return this.render();
    }
    if (this.suggestions) {
      const list = this.suggestions;
      if (name === 'up' || name === 'down') {
        list.index = (list.index + (name === 'up' ? -1 : 1) + list.items.length) % list.items.length;
        return this.render();
      }
      if (name === 'tab' || (name === 'enter' && !key.meta && !key.ctrl)) {
        const item = this.acceptSuggestion();
        if (name === 'enter' && (item.label.startsWith('/') || item.whole)) return this.submit();
        this.updateSuggestions();
        return this.render();
      }
    }
    if (name === 'enter') {
      if (key.meta || key.ctrl || key.shift) editor.insert('\n');
      else if (editor.text.slice(0, editor.cursor).endsWith('\\')) {
        editor.backspace();
        editor.insert('\n');
      } else return this.submit();
    } else if (name === 'paste') this.paste(key.paste);
    else if (key.meta && name === 'v') return this.pasteImage();
    else if (name === 'backspace') key.meta || key.ctrl ? editor.deleteWord() : this.backspace();
    else if (name === 'delete') editor.del();
    else if (name === 'left') key.ctrl || key.meta ? editor.wordLeft() : editor.left();
    else if (name === 'right') key.ctrl || key.meta ? editor.wordRight() : editor.right();
    else if (name === 'home' || (key.ctrl && name === 'a')) editor.home();
    else if (name === 'end' || (key.ctrl && name === 'e')) editor.end();
    else if (name === 'up') {
      if (editor.up()) {
        /* subio de linea */
      } else if (this.running && this.agent.queue.length) this.unqueue();
      else editor.historyPrev();
    } else if (name === 'down') {
      if (!editor.down()) editor.historyNext();
    } else if (key.ctrl && name === 'u') editor.killToStart();
    else if (key.ctrl && name === 'k') editor.killToEnd();
    else if (key.ctrl && name === 'w') editor.deleteWord();
    else if (key.ctrl && name === 'l') {
      this.term.prev = [];
      return this.render();
    } else if (key.ctrl && name === 'o') return this.toggleVerbose();
    else if (key.ctrl && name === 'r') return this.searchHistory();
    else if (key.ctrl && name === 't') {
      this.showTodos = !this.showTodos;
      this.flash(this.showTodos ? 'lista de tareas visible' : 'lista de tareas oculta');
    } else if (key.meta && name === 'b') editor.wordLeft();
    else if (key.meta && name === 'f') editor.wordRight();
    else if (name === '?' && !editor.text) {
      this.add(() => shortcutsLines());
      return this.render();
    } else if (key.text && !key.ctrl && !key.meta) editor.insert(key.text);
    this.updateSuggestions();
    this.render();
  }

  // Los mensajes que mandaste mientras bichi trabajaba y que aun no leyo vuelven a la entrada para editarlos.
  unqueue() {
    const texts = this.agent.queue.splice(0);
    for (const item of this.pendingSteer.splice(0)) item.remove();
    const current = this.editor.text;
    this.editor.set([...texts, current].filter(Boolean).join('\n'));
    this.flash('mensaje en cola de vuelta para editarlo · enter lo manda otra vez');
  }

  // Una marca de imagen se borra entera.
  backspace() {
    const before = this.editor.text.slice(0, this.editor.cursor);
    const tag = /\[Imagen #\d+\]$/.exec(before);
    if (!tag) return this.editor.backspace();
    this.editor.text = this.editor.text.slice(0, this.editor.cursor - tag[0].length) + this.editor.text.slice(this.editor.cursor);
    this.editor.cursor -= tag[0].length;
  }

  // Pegar (o arrastrar a la terminal) la ruta de una imagen la adjunta como [Imagen #n].
  paste(raw) {
    // Sin invisibles (la marca BOM que mete PowerShell, espacios de ancho cero) ni tabs: el cursor contaria
    // columnas que la terminal no dibuja y quedaria un hueco despues del texto.
    const text = String(raw)
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, '  ')
      .replace(/[\u200b-\u200f\u2060-\u2064\ufeff]/g, '')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    const image = imagePath(text, this.cwd);
    if (image) return this.attach(storeImage(image));
    this.editor.paste(text);
  }

  attach(image) {
    const tag = `[Imagen #${++this.imageCount}]`;
    this.images.set(tag, image);
    const before = this.editor.text.slice(0, this.editor.cursor);
    this.editor.insert(`${before && !/\s$/.test(before) ? ' ' : ''}${tag} `);
    this.updateSuggestions();
    this.render();
  }

  async pasteImage() {
    this.flash('leyendo el portapapeles…');
    const image = await clipboardImage().catch(() => null);
    if (!image) return this.flash('no hay ninguna imagen en el portapapeles');
    this.attach(image);
  }

  toggleVerbose() {
    this.config.verbose = !this.config.verbose;
    saveConfig(this.config);
    this.transcript.items.forEach((item) => item.update());
    this.flash(this.config.verbose ? 'detalle: resultados completos y razonamiento visibles (ctrl+o)' : 'detalle oculto (ctrl+o)');
    this.render();
  }

  async searchHistory() {
    const found = await this.overlayRun(new HistorySearch(this.editor.history));
    if (found) this.editor.set(found);
    this.render();
  }

  interrupt() {
    if (!this.running) return;
    this.running.interrupted = true;
    if (this.agent.goal) this.agent.goal.paused = true;
    this.agent.interrupt();
  }

  // ---------- enviar ----------

  async submit() {
    const raw = this.editor.value();
    const text = raw.trim();
    this.suggestions = null;
    if (!text) return this.render();
    this.editor.remember(raw);
    this.state.history = this.editor.history;
    saveState(this.state);
    this.editor.clear();
    this.follow = true;

    if (this.running) {
      if (text.startsWith('/')) return this.flash('espera a que termine (o pulsa esc) para usar comandos');
      this.agent.steer(text);
      this.pendingSteer.push(this.addUser(text, { pending: true }));
      return this.render();
    }
    if (text.startsWith('/')) {
      const [command, ...rest] = text.slice(1).split(/\s+/);
      this.render();
      this.addUser(text);
      return runCommand(this, command.toLowerCase(), rest.join(' ').trim(), text);
    }
    if (text.startsWith('!')) return this.runShell(text.slice(1).trim());
    if (text.startsWith('#')) return this.remember(text.slice(1).trim());
    return this.send(text);
  }

  async send(text, { display = text } = {}) {
    this.follow = true;
    if (!this.session.title && !display.startsWith('/')) this.session.title = display.replace(/\[Imagen #\d+\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const images = [...this.images].filter(([tag]) => text.includes(tag));
    // Si lo cancelas (esc) antes de que el modelo conteste o haga algo, el mensaje vuelve a la entrada como estaba.
    const mark = this.transcript.items.length;
    const index = this.agent.messages.length;
    this.unsent = () => {
      if (!this.agent.messages.slice(index).every((message) => message.role === 'user')) return false;
      this.agent.messages.splice(index);
      if (this.agent.turns.at(-1)?.index === index) this.agent.turns.pop();
      for (const item of this.transcript.items.slice(mark)) item.remove();
      this.editor.set([display, this.editor.text].filter(Boolean).join('\n'));
      return true;
    };
    this.addUser(display);
    const ended = await this.run(async () => {
      let content = this.withContext(text);
      // agy (Gemini) ve las imagenes el mismo: van tal cual con el mensaje, sin describirlas antes.
      if (isAgy(this.config.model)) return this.agyTurns(content, images.map(([tag, image]) => ({ tag, name: image.name === 'portapapeles' ? path.basename(image.file) : image.name, data: readFileSync(image.file).toString('base64') })));
      // El modelo ve las imagenes el mismo: van adjuntas y en el texto queda de donde son.
      for (const [tag, image] of images) content += `\n\n${tag}: imagen adjunta (${image.name}, guardada en ${image.file})`;
      await this.agent.send(content, { images: images.map(([, image]) => image.file) });
    });
    this.unsent = null;
    if (await this.leftovers(ended)) return;
    await this.pursueGoal();
  }

  // Mensajes en cola que el turno no llego a leer (fallo o lo cortaste): nunca se pierden. Si lo interrumpiste vuelven
  // a la entrada para editarlos; si no, se mandan como mensaje nuevo.
  async leftovers(ended) {
    if (!this.agent.queue.length) return false;
    if (ended.interrupted) {
      this.unqueue();
      this.render();
      return true;
    }
    const text = this.agent.queue.splice(0).join('\n\n');
    for (const item of this.pendingSteer.splice(0)) item.remove();
    await this.send(text);
    return true;
  }

  // Modo agy: un turno de Antigravity y, si escribiste mientras trabajaba, otro con eso (agy no lee a mitad de turno).
  // El mensaje en cola se mueve abajo del todo, despues de la respuesta del turno que acaba de terminar.
  async agyTurns(content, images = []) {
    await runAgy(this, content, images);
    while (this.agent.queue.length && !this.running?.interrupted) {
      const text = this.agent.queue.splice(0).join('\n\n');
      for (const item of this.pendingSteer.splice(0)) item.remove();
      this.endText();
      this.addUser(text);
      this.unsent = null;
      await runAgy(this, text);
    }
  }

  // /goal: mientras el objetivo no este cumplido, bichi sigue trabajando solo (con un tope de rondas).
  async pursueGoal() {
    const goal = this.agent.goal;
    if (!goal) return;
    if (goal.done) {
      const summary = goal.done;
      this.agent.goal = null;
      this.add(() => [notice(`objetivo cumplido: ${summary}`, c.ok)]);
      return this.render();
    }
    if (goal.paused || goal.rounds >= GOAL_ROUNDS) {
      goal.paused = true;
      this.add(() => [notice('objetivo en pausa · /goal para seguir, /goal off para dejarlo', c.warn)]);
      return this.render();
    }
    goal.rounds++;
    this.add(() => [notice(`objetivo · ronda ${goal.rounds + 1}`, c.ok)]);
    await this.run(() => this.agent.send(`(sigue con el objetivo: ${goal.text}. Revisa que falta, hazlo y verificalo. Si ya esta cumplido del todo, llama goal_done.)`));
    return this.pursueGoal();
  }

  withContext(text) {
    const extra = [...this.pendingContext.splice(0)];
    for (const match of text.matchAll(/(?:^|\s)@([^\s]+)/g)) {
      const file = path.resolve(this.cwd, match[1]);
      try {
        if (existsSync(file) && readFileSync(file).length < 200_000) extra.push(`<archivo ruta="${match[1]}">\n${readFileSync(file, 'utf8')}\n</archivo>`);
      } catch {
        /* carpeta o ilegible: queda la mencion */
      }
    }
    if (this.interruptedLast) {
      extra.push('(nota: el usuario interrumpio tu trabajo anterior)');
      this.interruptedLast = false;
    }
    return extra.length ? `${extra.join('\n\n')}\n\n${text}` : text;
  }

  // Devuelve el estado del turno (interrupted incluido) para saber como acabo.
  async run(job) {
    const state = { started: Date.now(), verb: VERBS[Math.floor(Math.random() * VERBS.length)], chars: 0 };
    this.running = state;
    this.verbTimer = setInterval(() => {
      if (this.running) this.running.verb = VERBS[Math.floor(Math.random() * VERBS.length)];
    }, 9000);
    this.setTitle();
    this.render();
    try {
      await job();
    } catch (error) {
      this.endText();
      if (error.name === 'AbortError') {
        if (this.unsent?.()) {
          this.running.interrupted = true;
          this.flash('cancelado · tu mensaje volvio a la entrada para editarlo');
        } else {
          this.note('interrumpido · dime que hago distinto', c.warn);
          this.interruptedLast = true;
        }
      } else {
        this.note(error.message, c.err);
        this.note('prueba otra vez, /model para elegir otro modelo o /config para tus claves');
      }
    } finally {
      clearInterval(this.verbTimer);
      this.endText();
      for (const item of this.toolItems.values()) item.remove();
      this.toolItems.clear();
      // Cartel de cierre: cuanto trabajo y a que hora termino.
      if (!this.running.interrupted && Date.now() - this.running.started > 1500) {
        const seconds = Math.round((Date.now() - this.running.started) / 1000);
        const verb = DONE_VERBS[Math.floor(Math.random() * DONE_VERBS.length)];
        const hour = new Date().toLocaleTimeString('es', { hour: 'numeric', minute: '2-digit' });
        // Se guarda con el ultimo mensaje para que siga ahi al retomar la conversacion.
        const stamp = `${verb} durante ${clock(seconds)} · listo ${hour}`;
        (this.session.stamps ??= {})[this.agent.messages.length - 1] = stamp;
        this.add(() => stampLine(stamp));
      }
      this.running = null;
      this.saveSession();
      this.setTitle();
      this.refreshFiles();
      this.render();
    }
    return state;
  }

  // ---------- eventos del agente ----------

  endText() {
    this.assistant = null;
    this.closeThinking();
  }

  closeThinking() {
    const thinking = this.thinking;
    if (!thinking) return;
    this.thinking = null;
    thinking.seconds = Math.max(1, Math.round((Date.now() - thinking.started) / 1000));
    if (thinking.seconds < 2 && !this.config.verbose) thinking.remove();
    else thinking.update();
  }

  agentUi() {
    return {
      onModel: () => this.schedule(),
      onReasoning: (text) => {
        if (!this.thinking) {
          const item = this.add((w) =>
            item.seconds
              ? reasoningBlock(item.text, item.seconds, w, this.config.verbose || item.expanded)
              : [`${c.plum('»')} ${dim('pensando…')}`, ...(this.config.verbose || item.expanded ? item.text.slice(-800).split('\n').flatMap((part) => wrap(dim(part), w - 4)).map((line) => `  ${line}`) : [])],
          );
          item.toggle = () => (item.expanded = !item.expanded);
          item.text = '';
          item.started = Date.now();
          this.thinking = item;
        }
        this.thinking.text += text;
        this.thinking.update();
        if (this.running) this.running.chars += text.length;
        this.schedule();
      },
      onText: (text) => {
        this.closeThinking();
        if (!this.assistant) {
          if (!text.trim()) return;
          const item = this.add((w) => assistantLines(item.text, w));
          item.text = '';
          this.assistant = item;
          text = text.replace(/^\s+/, '');
        }
        this.assistant.text += text;
        this.assistant.update();
        if (this.running) this.running.chars += text.length;
        this.schedule();
      },
      onAssistantEnd: () => this.endText(),
      onSwitch: (info) => {
        if (info.reset && this.assistant) {
          this.assistant.remove();
          this.assistant = null;
        }
        const from = displayName(this.config, info.from);
        if (info.to && info.to !== info.from) this.note(`${from}: ${info.reason} · sigo con ${displayName(this.config, info.to)}`, c.warn);
        else if (!info.to) this.note(`${from}: ${info.reason}`, c.warn);
      },
      onToolStart: (view) => {
        this.endText();
        const item = this.add((w) => this.toolRender(view, w));
        this.toolItems.set(view.id, item);
      },
      onToolProgress: (id, output) => {
        const item = this.toolItems.get(id);
        if (item) item.progress = output.slice(-2000);
      },
      onSubActivity: (id, sub, reason) => {
        const item = this.toolItems.get(id);
        if (item) (item.activity ??= []).push(`${sub.label.title} ${sub.label.arg ?? ''}${reason ? ` (${reason})` : ''}`.trim());
        this.schedule();
      },
      onSubagents: () => this.schedule(),
      onToolEnd: (view, outcome) => {
        const item = this.toolItems.get(view.id);
        this.toolItems.delete(view.id);
        // Lecturas seguidas: se juntan en un solo bloque plegado ("leyo 4 archivos, busco 2 textos").
        if (READ_TOOLS.has(view.tool.name) && !outcome.error && !view.sub) {
          item?.remove();
          const items = this.transcript.items;
          let group = items.at(-1)?.readGroup ? items.at(-1) : null;
          if (!group) {
            group = this.add((w) => readGroupBlock(group.readGroup, w, this.config.verbose || group.expanded));
            group.readGroup = [];
            group.toggle = () => (group.expanded = !group.expanded);
          }
          group.readGroup.push({ view, outcome });
          group.update();
          return this.schedule();
        }
        const done = (w) => toolBlock(view, outcome, { columns: w, verbose: this.config.verbose || target.expanded });
        const target = item ?? this.add(done);
        target.render = done;
        target.toggle = () => (target.expanded = !target.expanded);
        target.update();
        this.schedule();
      },
      onToolDenied: (view, reason) => {
        this.endText();
        this.add(() => deniedBlock(view, reason));
      },
      onNotice: (text) => this.note(text, c.warn),
      onRetry: ({ attempt, of, wait, reason }) => this.note(`${reason} · reintento ${attempt} de ${of} en ${Math.ceil(wait / 1000)}s`, c.warn),
      onSteer: (text) => {
        this.endText();
        // Ya lo leyo: el mensaje en cola pasa al sombreado normal.
        const queued = this.pendingSteer.shift();
        if (queued) {
          queued.pending = false;
          queued.update();
        } else this.addUser(text);
      },
      onCompact: (phase) => {
        if (phase === 'start') this.note('el contexto se esta llenando: resumiendo la conversacion con los modelos gratis…', c.plum);
        else {
          this.session.stamps = {}; // los mensajes se renumeran al resumir
          this.note('conversacion resumida, sigo con espacio libre', c.ok);
        }
      },
      permission: (view, preview, rule) => this.askPermission(view, preview, rule),
      allowProject: (rule) => addProjectAllow(this.cwd, rule),
      question: (question, options) => this.askQuestion(question, options),
      approvePlan: (plan) => this.approvePlan(plan),
    };
  }

  toolRender(view, w) {
    const item = this.toolItems.get(view.id);
    const lines = [toolTitle(view, 'running').replace('●', this.tick % 8 < 4 ? c.brand('●') : c.deep('●'))];
    if (item?.progress) for (const line of item.progress.trimEnd().split('\n').slice(-4)) lines.push(`    ${dim(truncate(strip(line), w - 8))}`);
    for (const activity of (item?.activity ?? []).slice(-4)) lines.push(`  ${c.soft('╰')}  ${dim(truncate(activity, w - 8))}`);
    return lines;
  }

  // ---------- dialogos ----------

  async overlayRun(widget) {
    this.overlay = widget;
    this.render();
    try {
      return await widget.promise;
    } finally {
      this.overlay = null;
      this.render();
    }
  }

  choose(spec) {
    return this.overlayRun(new Menu(spec));
  }

  field(spec) {
    return this.overlayRun(new Field(spec));
  }

  async askPermission(view, preview, rule) {
    this.endText();
    const name = view.tool.name;
    const body = [];
    const { width: W, height: H } = this.term.size();
    const room = Math.max(6, H - 16);
    if (name === 'shell') {
      body.push(c.ice(String(view.input.command)));
      if (view.input.description) body.push(dim(view.input.description));
    } else if (preview?.ops) {
      body.push(`${c.ice(preview.file)}${preview.created ? c.soft('  (nuevo)') : ''}`);
      body.push(...renderDiff(preview.ops, { columns: Math.min(W, 100) - 8, maxLines: room }));
    } else body.push(c.ice(`${view.label.arg ?? ''}`), dim(JSON.stringify(view.input).slice(0, 300)));
    const what = name === 'shell' ? 'ejecuto este comando' : name === 'edit' ? 'aplico este cambio' : name === 'write' ? (preview?.created ? 'creo este archivo' : 'reescribo este archivo') : `uso ${view.label.title}`;
    const ruleText = rule.startsWith('shell:') ? `"${rule.slice(6)}"` : 'ediciones de archivos';
    const options = [
      { label: 'si', value: 'yes' },
      { label: `si, y no preguntes mas por ${ruleText} en esta sesion`, value: 'always' },
      ...(name === 'shell' ? [{ label: 'si, y siempre en este proyecto', value: 'project' }] : []),
      { label: 'no, y decirle que hacer distinto', value: 'no', hint: 'esc' },
    ];
    const title = view.sub ? `${view.label.title} · ${view.sub}` : view.label.title;
    const choice = await this.choose({ title, body: [...body, '', bold(`¿${what}?`)], options, escape: 'no', color: name === 'shell' ? c.warn : c.brand });
    if (choice === 'always' && name !== 'shell') this.mode = 'edits';
    if (choice !== 'no') return { choice };
    const feedback = await this.field({ title: 'que hago distinto', hint: 'cuentale a bichi que prefieres (enter vacio para solo decir que no)' });
    return { choice: 'no', feedback: feedback || '' };
  }

  async askQuestion(question, options) {
    this.endText();
    const list = options.slice(0, 6).map((option) => ({ label: option, value: option }));
    list.push({ label: 'escribir otra respuesta', value: '\u0000other' });
    const answer = await this.choose({ title: 'bichi pregunta', body: [c.ice(question)], options: list, escape: null });
    if (answer === '\u0000other') return this.field({ title: 'tu respuesta', hint: question });
    return answer;
  }

  async approvePlan(plan) {
    this.endText();
    this.add((w) => box(renderMarkdown(plan, Math.min(w, 110) - 6), Math.min(w - 1, 110), { title: 'plan', color: c.ok }));
    const choice = await this.choose({
      title: 'plan listo',
      body: ['¿sigo con este plan?'],
      options: [
        { label: 'si, y acepta las ediciones solo', value: 'edits' },
        { label: 'si, pero preguntame cada cambio', value: 'normal' },
        { label: 'no, sigue planeando', value: 'no', hint: 'esc' },
      ],
      escape: 'no',
      color: c.ok,
    });
    if (choice === 'no') {
      const feedback = await this.field({ title: 'que cambio del plan', hint: 'enter vacio para que siga investigando' });
      return { ok: false, feedback };
    }
    this.mode = choice;
    return { ok: true, mode: choice };
  }

  // Esc esc: volver a un mensaje anterior, con o sin el codigo de ese momento.
  async rewind() {
    const turns = this.agent.messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.role === 'user' && typeof message.content === 'string' && !message.content.startsWith('('));
    if (!turns.length) return this.flash('aun no hay mensajes a los que volver');
    const options = turns
      .slice(-12)
      .reverse()
      .map(({ message, index }) => {
        const changed = this.agent.changedSince(index).length;
        const label = truncate(stripAttachments(message.content).replace(/\s+/g, ' '), 70);
        return { label, hint: changed ? `${changed} ${changed === 1 ? 'turno con cambios' : 'turnos con cambios'} de codigo despues` : '', value: index };
      });
    const index = await this.choose({ title: 'volver a un mensaje', body: [dim('la conversacion vuelve a antes de ese mensaje y el texto queda para editarlo.')], options, escape: null });
    if (index === null) return;
    let code = false;
    if (this.agent.changedSince(index).length) {
      const choice = await this.choose({
        title: 'restaurar',
        options: [
          { label: 'conversacion y codigo', hint: 'deshace tambien los cambios en archivos', value: 'both' },
          { label: 'solo la conversacion', hint: 'los archivos quedan como estan', value: 'chat' },
          { label: 'solo el codigo', hint: 'la conversacion sigue igual', value: 'code' },
        ],
        escape: null,
      });
      if (!choice) return;
      if (choice === 'code') {
        const files = await this.agent.restore(this.agent.changedSince(index));
        this.agent.turns = this.agent.turns.filter((turn) => turn.index < index);
        return this.note(`codigo restaurado en ${files.length} ${files.length === 1 ? 'archivo' : 'archivos'}`, c.ok);
      }
      code = choice === 'both';
    }
    const text = stripAttachments(this.agent.messages[index].content);
    const files = await this.agent.rewind(index, { code });
    // agy no puede rebobinar su propia conversacion: la siguiente empieza otra, con lo que quedo como contexto.
    delete this.session.agy;
    for (const key of Object.keys(this.session.stamps ?? {})) if (Number(key) >= index) delete this.session.stamps[key];
    this.replay();
    this.editor.set(text);
    this.note(`conversacion rebobinada${files.length ? ` y codigo restaurado en ${files.length} ${files.length === 1 ? 'archivo' : 'archivos'}` : ''}; edita el mensaje y envialo`, c.ok);
    this.render();
  }

  // ! comando: se ejecuta aqui y la salida va como contexto del siguiente mensaje.
  async runShell(command) {
    if (!command) return;
    const view = { id: 'bang', tool: shellTool, input: { command }, label: { title: 'Shell', arg: command } };
    this.add(() => [`${c.warn('!')} ${c.ice(command)}`]);
    await this.run(async () => {
      const item = this.add((w) => this.toolRender(view, w), { gap: 0 });
      this.toolItems.set('bang', item);
      const controller = new AbortController();
      this.agent.controller = controller;
      const result = await shellTool.run({ command, timeout: 600 }, { cwd: this.cwd, config: this.config, signal: controller.signal, progress: (output) => (item.progress = output.slice(-2000)) });
      this.toolItems.delete('bang');
      this.agent.controller = null;
      const lines = (result.output ?? '').split('\n');
      item.render = () => [...lines.slice(-200).map((line) => `  ${dim(line)}`), ...(result.exit ? [notice(`codigo ${result.exit}`, c.warn)] : [])];
      item.update();
      this.pendingContext.push(`(el usuario ejecuto en su terminal: ${command})\n<salida>\n${result.content.slice(0, 20000)}\n</salida>`);
    });
  }

  // # nota: a la memoria del proyecto (.bichi/BICHI.md), local o de usuario.
  async remember(note) {
    if (!note) return;
    const { paths } = await import('./config.mjs');
    const where = await this.choose({
      title: 'guardar en la memoria',
      body: [c.ice(note)],
      options: [
        { label: 'memoria del proyecto', hint: '.bichi/BICHI.md, se comparte en el repo', value: path.join(this.cwd, '.bichi', 'BICHI.md') },
        { label: 'memoria local del proyecto', hint: '.bichi/BICHI.local.md, solo para ti', value: path.join(this.cwd, '.bichi', 'BICHI.local.md') },
        { label: 'memoria de usuario', hint: 'para todos tus proyectos', value: paths.memory },
      ],
      escape: null,
    });
    if (!where) return;
    const { appendFile, mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(where), { recursive: true });
    const exists = existsSync(where);
    const prefix = !exists ? '# Memoria para bichi\n\n' : readFileSync(where, 'utf8').endsWith('\n') ? '' : '\n';
    await appendFile(where, `${prefix}- ${note}\n`);
    this.note(`guardado en ${where}`, c.ok);
  }
}

// Respuesta de bichi: markdown con un punto delante.
export function assistantLines(text, w) {
  return renderMarkdown(text, w - 3).map((line, i) => `${i === 0 ? c.ice('●') : ' '} ${line}`);
}

// El texto que escribio el usuario, sin los archivos (@) ni las descripciones de imagenes que se le adjuntaron.
const stripAttachments = (text) =>
  text
    .replace(/<archivo ruta="[^"]+">[\s\S]*?<\/archivo>\n*/g, '')
    .replace(/\n\n\[Imagen #\d+\] \([^)]*\):\n[\s\S]*$/, '')
    .trim();

// Resalta en blanco las letras que coinciden con lo escrito, como al buscar.
function markMatch(label, query, active) {
  const paint = active ? (text) => bold(c.sky(text)) : c.ice;
  const at = query ? label.toLowerCase().indexOf(query) : -1;
  if (at < 0) return paint(label);
  return paint(label.slice(0, at)) + bold(fg('#ffffff')(label.slice(at, at + query.length))) + paint(label.slice(at + query.length));
}

// Cartel de cierre de una respuesta: cuanto trabajo y a que hora termino.
const stampLine = (stamp) => [`${c.soft('◈')} ${dim(stamp)}`];

const highlightTags = (line) => line.replace(/\[(Imagen #\d+|pegado #\d+ \+\d+ lineas)\]/g, (tag) => fg('#c4a6f5')(tag));

function safe(fn) {
  try {
    return fn();
  } catch {
    return { title: '?', arg: '' };
  }
}

const clock = (seconds) => (seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`);

export function openTarget(url) {
  const target = url.startsWith('file:') ? decodeURIComponent(url.replace(/^file:\/\/\/?/, process.platform === 'win32' ? '' : '/')) : url;
  const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', target]] : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// Texto del portapapeles del sistema (para pegar con clic derecho).
function readClipboard() {
  const [command, args] =
    process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-Command', '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; Get-Clipboard -Raw']]
      : process.platform === 'darwin'
        ? ['pbpaste', []]
        : ['sh', ['-c', 'wl-paste --no-newline 2>/dev/null || xclip -selection clipboard -o']];
  return new Promise((resolve) => {
    let out = '';
    try {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      child.stdout.on('data', (chunk) => (out += chunk));
      child.on('error', () => resolve(''));
      child.on('close', () => resolve(out.replace(/\r\n/g, '\n').replace(/\n$/, '')));
    } catch {
      resolve('');
    }
  });
}

function copyNative(text) {
  const [command, args] = process.platform === 'win32' ? ['clip', []] : process.platform === 'darwin' ? ['pbcopy', []] : ['sh', ['-c', 'wl-copy 2>/dev/null || xclip -selection clipboard']];
  try {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(process.platform === 'win32' ? Buffer.from(`﻿${text}`, 'utf16le') : text);
  } catch {
    /* sin portapapeles nativo: queda el OSC 52 */
  }
}

export function formatTokens(count) {
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k` : String(count);
}

const SHORTCUTS = [
  ['enter', 'enviar'],
  ['shift+enter · alt+enter · \\ enter', 'nueva linea'],
  ['shift+tab', 'cambiar modo: normal, acepta ediciones, plan, sin preguntas'],
  ['esc', 'interrumpir a bichi (si aun no contesto, tu mensaje vuelve a la entrada)'],
  ['esc esc', 'salir de bichi (con la entrada vacia; si no, la borra)'],
  ['/rewind', 'volver a un mensaje anterior (con o sin el codigo)'],
  ['escribir mientras trabaja', 'redirigir sin parar (entra en el siguiente paso; flecha arriba lo trae para editarlo)'],
  ['clic · arrastrar en la entrada', 'mover el cursor · seleccionar (escribir reemplaza, shift+flechas amplia)'],
  ['/', 'comandos y skills'],
  ['@ruta', 'mencionar un archivo o carpeta (tab entra en carpetas)'],
  ['alt+v · pegar una ruta', 'adjuntar una imagen'],
  ['!comando', 'ejecutar en la shell y darselo a bichi como contexto'],
  ['#nota', 'guardar en la memoria'],
  ['ctrl+r', 'buscar en lo que escribiste antes'],
  ['ctrl+o', 'ver resultados completos y razonamiento'],
  ['ctrl+t', 'mostrar u ocultar la lista de tareas'],
  ['rueda · re pag · av pag', 'moverse por la conversacion'],
  ['arrastrar con el raton', 'seleccionar y copiar · clic en un link para abrirlo'],
  ['ctrl+c ctrl+c', 'salir'],
];

export function shortcutsLines() {
  return [bold(c.brand('atajos')), ...SHORTCUTS.map(([keys, label]) => `  ${fg('#a6d2ff')(pad(keys, 30))} ${c.soft(label)}`)];
}

export const shortcutsHelp = () => shortcutsLines().join('\n');
